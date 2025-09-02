use windows::{
    Foundation::TimeSpan,
    Graphics::SizeInt32,
    Win32::{
        Foundation::E_NOTIMPL,
        Graphics::{
            Direct3D11::{ID3D11Device, ID3D11Texture2D},
            Dxgi::Common::{DXGI_FORMAT, DXGI_FORMAT_NV12},
        },
        Media::MediaFoundation::{
            IMFAsyncCallback, IMFAttributes, IMFDXGIDeviceManager, IMFMediaEvent,
            IMFMediaEventGenerator, IMFMediaType, IMFSample, IMFTransform,
            MEDIA_EVENT_GENERATOR_GET_EVENT_FLAGS, MF_E_INVALIDMEDIATYPE, MF_E_NO_MORE_TYPES,
            MF_E_TRANSFORM_TYPE_NOT_SET, MF_EVENT_TYPE, MF_MT_ALL_SAMPLES_INDEPENDENT,
            MF_MT_AVG_BITRATE, MF_MT_FRAME_RATE, MF_MT_FRAME_SIZE, MF_MT_INTERLACE_MODE,
            MF_MT_MAJOR_TYPE, MF_MT_PIXEL_ASPECT_RATIO, MF_MT_SUBTYPE,
            MF_READWRITE_ENABLE_HARDWARE_TRANSFORMS, MF_TRANSFORM_ASYNC_UNLOCK,
            MFCreateDXGIDeviceManager, MFCreateDXGISurfaceBuffer, MFCreateMediaType,
            MFCreateSample, MFMediaType_Video, MFT_MESSAGE_COMMAND_FLUSH,
            MFT_MESSAGE_NOTIFY_BEGIN_STREAMING, MFT_MESSAGE_NOTIFY_END_OF_STREAM,
            MFT_MESSAGE_NOTIFY_END_STREAMING, MFT_MESSAGE_NOTIFY_START_OF_STREAM,
            MFT_MESSAGE_SET_D3D_MANAGER, MFT_OUTPUT_DATA_BUFFER, MFT_SET_TYPE_TEST_ONLY,
            MFVideoFormat_H264, MFVideoFormat_NV12, MFVideoInterlace_Progressive,
        },
    },
    core::{Error, Interface},
};

use crate::{
    async_callback::AsyncCallback,
    media::{MFSetAttributeRatio, MFSetAttributeSize},
    mft::EncoderDevice,
    unsafe_send::UnsafeSend,
    video::{NewVideoProcessorError, VideoProcessor},
};

pub struct VideoEncoderInputSample {
    timestamp: TimeSpan,
    texture: ID3D11Texture2D,
}

impl VideoEncoderInputSample {
    pub fn new(timestamp: TimeSpan, texture: ID3D11Texture2D) -> Self {
        Self { timestamp, texture }
    }
}

pub struct VideoEncoderOutputSample {
    sample: IMFSample,
}

impl VideoEncoderOutputSample {
    pub fn sample(&self) -> &IMFSample {
        &self.sample
    }
}

pub struct H264Encoder {
    _d3d_device: ID3D11Device,
    _media_device_manager: IMFDXGIDeviceManager,
    _device_manager_reset_token: u32,

    video_processor: VideoProcessor,

    transform: IMFTransform,
    event_generator: IMFMediaEventGenerator,
    input_stream_id: u32,
    output_stream_id: u32,
    output_type: IMFMediaType,
    bitrate: u32,
}

#[derive(Clone, Debug, thiserror::Error)]
pub enum NewVideoEncoderError {
    #[error("NoVideoEncoderDevice")]
    NoVideoEncoderDevice,
    #[error("EncoderTransform: {0}")]
    EncoderTransform(windows::core::Error),
    #[error("VideoProcessor: {0}")]
    VideoProcessor(NewVideoProcessorError),
    #[error("DeviceManager: {0}")]
    DeviceManager(windows::core::Error),
    #[error("EventGenerator: {0}")]
    EventGenerator(windows::core::Error),
    #[error("ConfigureStreams: {0}")]
    ConfigureStreams(windows::core::Error),
    #[error("OutputType: {0}")]
    OutputType(windows::core::Error),
    #[error("InputType: {0}")]
    InputType(windows::core::Error),
}

unsafe impl Send for H264Encoder {}

impl H264Encoder {
    /// Recommended bitrate multipler: 0.05-0.1
    pub fn new(
        d3d_device: &ID3D11Device,
        format: DXGI_FORMAT,
        resolution: SizeInt32,
        frame_rate: u32,
        bitrate_multipler: f32,
    ) -> Result<Self, NewVideoEncoderError> {
        let bitrate = calculate_bitrate(
            resolution.Width as u32,
            resolution.Height as u32,
            frame_rate,
            bitrate_multipler,
        );

        let transform = EncoderDevice::enumerate(MFMediaType_Video, MFVideoFormat_H264)
            .map_err(|_| NewVideoEncoderError::NoVideoEncoderDevice)?
            .first()
            .cloned()
            .ok_or(NewVideoEncoderError::NoVideoEncoderDevice)?
            .create_transform()
            .map_err(NewVideoEncoderError::EncoderTransform)?;

        let video_processor = VideoProcessor::new(
            d3d_device.clone(),
            format,
            resolution,
            DXGI_FORMAT_NV12,
            resolution,
            frame_rate,
        )
        .map_err(NewVideoEncoderError::VideoProcessor)?;

        // Create MF device manager
        let mut device_manager_reset_token: u32 = 0;
        let media_device_manager = {
            let mut media_device_manager = None;
            unsafe {
                MFCreateDXGIDeviceManager(
                    &mut device_manager_reset_token,
                    &mut media_device_manager,
                )
                .map_err(NewVideoEncoderError::DeviceManager)?
            };
            media_device_manager.unwrap()
        };
        unsafe {
            media_device_manager
                .ResetDevice(d3d_device, device_manager_reset_token)
                .map_err(NewVideoEncoderError::DeviceManager)?
        };

        // Setup MFTransform
        let event_generator: IMFMediaEventGenerator = transform
            .cast()
            .map_err(NewVideoEncoderError::EventGenerator)?;
        let attributes = unsafe {
            transform
                .GetAttributes()
                .map_err(NewVideoEncoderError::EventGenerator)?
        };
        unsafe {
            attributes
                .SetUINT32(&MF_TRANSFORM_ASYNC_UNLOCK, 1)
                .map_err(NewVideoEncoderError::EventGenerator)?;
            attributes
                .SetUINT32(&MF_READWRITE_ENABLE_HARDWARE_TRANSFORMS, 1)
                .map_err(NewVideoEncoderError::EventGenerator)?;
        };

        let mut number_of_input_streams = 0;
        let mut number_of_output_streams = 0;
        unsafe {
            transform
                .GetStreamCount(&mut number_of_input_streams, &mut number_of_output_streams)
                .map_err(NewVideoEncoderError::EventGenerator)?
        };
        let (input_stream_ids, output_stream_ids) = {
            let mut input_stream_ids = vec![0u32; number_of_input_streams as usize];
            let mut output_stream_ids = vec![0u32; number_of_output_streams as usize];
            let result =
                unsafe { transform.GetStreamIDs(&mut input_stream_ids, &mut output_stream_ids) };
            match result {
                Ok(_) => {}
                Err(error) => {
                    // https://docs.microsoft.com/en-us/windows/win32/api/mftransform/nf-mftransform-imftransform-getstreamids
                    // This method can return E_NOTIMPL if both of the following conditions are true:
                    //   * The transform has a fixed number of streams.
                    //   * The streams are numbered consecutively from 0 to n – 1, where n is the
                    //     number of input streams or output streams. In other words, the first
                    //     input stream is 0, the second is 1, and so on; and the first output
                    //     stream is 0, the second is 1, and so on.
                    if error.code() == E_NOTIMPL {
                        for i in 0..number_of_input_streams {
                            input_stream_ids[i as usize] = i;
                        }
                        for i in 0..number_of_output_streams {
                            output_stream_ids[i as usize] = i;
                        }
                    } else {
                        return Err(NewVideoEncoderError::ConfigureStreams(error));
                    }
                }
            }
            (input_stream_ids, output_stream_ids)
        };
        let input_stream_id = input_stream_ids[0];
        let output_stream_id = output_stream_ids[0];

        // TOOD: Avoid this AddRef?
        unsafe {
            let temp = media_device_manager.clone();
            transform
                .ProcessMessage(MFT_MESSAGE_SET_D3D_MANAGER, std::mem::transmute(temp))
                .map_err(NewVideoEncoderError::EncoderTransform)?;
        };

        let output_type = (|| unsafe {
            let output_type = MFCreateMediaType()?;
            let attributes: IMFAttributes = output_type.cast()?;
            output_type.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video)?;
            output_type.SetGUID(&MF_MT_SUBTYPE, &MFVideoFormat_H264)?;
            output_type.SetUINT32(&MF_MT_AVG_BITRATE, bitrate)?;
            MFSetAttributeSize(
                &attributes,
                &MF_MT_FRAME_SIZE,
                resolution.Width as u32,
                resolution.Height as u32,
            )?;
            MFSetAttributeRatio(&attributes, &MF_MT_FRAME_RATE, 60, 1)?;
            MFSetAttributeRatio(&attributes, &MF_MT_PIXEL_ASPECT_RATIO, 1, 1)?;
            output_type.SetUINT32(&MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive.0 as u32)?;
            output_type.SetUINT32(&MF_MT_ALL_SAMPLES_INDEPENDENT, 1)?;
            transform.SetOutputType(output_stream_id, &output_type, 0)?;
            Ok(output_type)
        })()
        .map_err(NewVideoEncoderError::OutputType)?;

        let input_type: Option<IMFMediaType> = (|| unsafe {
            let mut count = 0;
            loop {
                let result = transform.GetInputAvailableType(input_stream_id, count);
                if let Err(error) = &result {
                    if error.code() == MF_E_NO_MORE_TYPES {
                        break Ok(None);
                    }
                }

                let input_type = result?;
                let attributes: IMFAttributes = input_type.cast()?;
                input_type.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video)?;
                input_type.SetGUID(&MF_MT_SUBTYPE, &MFVideoFormat_NV12)?;
                MFSetAttributeSize(
                    &attributes,
                    &MF_MT_FRAME_SIZE,
                    resolution.Width as u32,
                    resolution.Height as u32,
                )?;
                MFSetAttributeRatio(&attributes, &MF_MT_FRAME_RATE, 60, 1)?;
                let result = transform.SetInputType(
                    input_stream_id,
                    &input_type,
                    MFT_SET_TYPE_TEST_ONLY.0 as u32,
                );
                if let Err(error) = &result {
                    if error.code() == MF_E_INVALIDMEDIATYPE {
                        count += 1;
                        continue;
                    }
                }
                result?;
                break Ok(Some(input_type));
            }
        })()
        .map_err(NewVideoEncoderError::InputType)?;
        if let Some(input_type) = input_type {
            unsafe { transform.SetInputType(input_stream_id, &input_type, 0) }
                .map_err(NewVideoEncoderError::InputType)?;
        } else {
            return Err(NewVideoEncoderError::InputType(Error::new(
                MF_E_TRANSFORM_TYPE_NOT_SET,
                "No suitable input type found! Try a different set of encoding settings.",
            )));
        }

        Ok(Self {
            _d3d_device: d3d_device.clone(),
            _media_device_manager: media_device_manager,
            _device_manager_reset_token: device_manager_reset_token,

            video_processor,

            transform,
            event_generator,
            input_stream_id,
            output_stream_id,
            bitrate,

            output_type,
        })
    }

    pub fn bitrate(&self) -> u32 {
        self.bitrate
    }

    pub fn output_type(&self) -> &IMFMediaType {
        &self.output_type
    }

    pub fn finish(&self) -> windows::core::Result<()> {
        unsafe {
            self.transform
                .ProcessMessage(MFT_MESSAGE_COMMAND_FLUSH, 0)?;
            self.transform
                .ProcessMessage(MFT_MESSAGE_NOTIFY_END_OF_STREAM, 0)?;
            self.transform
                .ProcessMessage(MFT_MESSAGE_NOTIFY_END_STREAMING, 0)?;
            self.transform
                .ProcessMessage(MFT_MESSAGE_COMMAND_FLUSH, 0)?;
        }
        Ok(())
    }

    pub fn start(&self) -> windows::core::Result<()> {
        unsafe {
            self.transform
                .ProcessMessage(MFT_MESSAGE_COMMAND_FLUSH, 0)?;
            self.transform
                .ProcessMessage(MFT_MESSAGE_NOTIFY_BEGIN_STREAMING, 0)?;
            self.transform
                .ProcessMessage(MFT_MESSAGE_NOTIFY_START_OF_STREAM, 0)?;
        }

        Ok(())
    }

    pub fn get_event_stream(
        &self,
    ) -> impl futures::Stream<Item = windows::core::Result<UnsafeSend<IMFMediaEvent>>> {
        let generator = UnsafeSend(self.event_generator.clone());

        futures::stream::unfold((), move |()| {
            let generator = generator.clone();
            async move {
                let (tx, rx) = futures::channel::oneshot::channel();

                let callback: IMFAsyncCallback = {
                    let generator = generator.clone();
                    AsyncCallback::new(move |result| {
                        let _ = tx.send(
                            unsafe { generator.EndGetEvent(result.unwrap()) }.map(UnsafeSend),
                        );
                    })
                    .into()
                };

                let _ = unsafe { generator.BeginGetEvent(&callback, None) };

                let val = rx.await.ok()?;

                Some((val, ()))
            }
        })
    }

    pub fn get_event(&self) -> windows::core::Result<MF_EVENT_TYPE> {
        let event = unsafe {
            self.event_generator
                .GetEvent(MEDIA_EVENT_GENERATOR_GET_EVENT_FLAGS(0))?
        };

        Ok(MF_EVENT_TYPE(unsafe { event.GetType()? } as i32))
    }

    pub fn handle_needs_input(
        &mut self,
        sample: VideoEncoderInputSample,
    ) -> windows::core::Result<()> {
        self.video_processor.process_texture(&sample.texture)?;

        let input_buffer = unsafe {
            MFCreateDXGISurfaceBuffer(
                &ID3D11Texture2D::IID,
                self.video_processor.output_texture(),
                0,
                false,
            )?
        };
        let mf_sample = unsafe { MFCreateSample()? };
        unsafe {
            mf_sample.AddBuffer(&input_buffer)?;
            mf_sample.SetSampleTime(sample.timestamp.Duration)?;
            self.transform
                .ProcessInput(self.input_stream_id, &mf_sample, 0)?;
        };
        Ok(())
    }

    pub fn handle_has_output(&mut self) -> windows::core::Result<Option<IMFSample>> {
        let mut status = 0;
        let output_buffer = MFT_OUTPUT_DATA_BUFFER {
            dwStreamID: self.output_stream_id,
            ..Default::default()
        };

        let sample = unsafe {
            let mut output_buffers = [output_buffer];
            self.transform
                .ProcessOutput(0, &mut output_buffers, &mut status)?;
            output_buffers[0].pSample.as_ref().cloned()
        };

        Ok(sample)
    }
}

fn calculate_bitrate(width: u32, height: u32, fps: u32, multiplier: f32) -> u32 {
    ((width * height * ((fps - 30) / 2 + 30)) as f32 * multiplier) as u32
}
