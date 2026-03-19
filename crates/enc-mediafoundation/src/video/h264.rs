use crate::{
    media::{MFSetAttributeRatio, MFSetAttributeSize},
    mft::EncoderDevice,
    video::{NewVideoProcessorError, VideoProcessor},
};
use std::{
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};
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
            self, IMFAttributes, IMFDXGIDeviceManager, IMFMediaEventGenerator, IMFMediaType,
            IMFSample, IMFTransform, MF_E_INVALIDMEDIATYPE, MF_E_NO_MORE_TYPES,
            MF_E_TRANSFORM_TYPE_NOT_SET, MF_EVENT_FLAG_NONE, MF_EVENT_TYPE,
            MF_MT_ALL_SAMPLES_INDEPENDENT, MF_MT_AVG_BITRATE, MF_MT_FRAME_RATE, MF_MT_FRAME_SIZE,
            MF_MT_INTERLACE_MODE, MF_MT_MAJOR_TYPE, MF_MT_PIXEL_ASPECT_RATIO, MF_MT_SUBTYPE,
            MF_READWRITE_ENABLE_HARDWARE_TRANSFORMS, MF_TRANSFORM_ASYNC_UNLOCK,
            MFCreateDXGIDeviceManager, MFCreateDXGISurfaceBuffer, MFCreateMediaType,
            MFCreateSample, MFMediaType_Video, MFT_ENUM_FLAG, MFT_ENUM_FLAG_HARDWARE,
            MFT_ENUM_FLAG_TRANSCODE_ONLY, MFT_MESSAGE_COMMAND_FLUSH,
            MFT_MESSAGE_NOTIFY_BEGIN_STREAMING, MFT_MESSAGE_NOTIFY_END_OF_STREAM,
            MFT_MESSAGE_NOTIFY_END_STREAMING, MFT_MESSAGE_NOTIFY_START_OF_STREAM,
            MFT_MESSAGE_SET_D3D_MANAGER, MFT_OUTPUT_DATA_BUFFER, MFT_SET_TYPE_TEST_ONLY,
            MFVideoFormat_H264, MFVideoFormat_NV12, MFVideoInterlace_Progressive,
        },
    },
    core::{Error, Interface},
};

const MAX_CONSECUTIVE_EMPTY_SAMPLES: u8 = 20;
const MAX_INPUT_WITHOUT_OUTPUT: u32 = 30;
const MAX_PROCESS_INPUT_FAILURES: u32 = 5;
const ENCODER_OPERATION_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Debug, Clone)]
pub struct EncoderHealthStatus {
    pub inputs_without_output: u32,
    pub consecutive_process_failures: u32,
    pub total_frames_encoded: u64,
    pub is_healthy: bool,
    pub failure_reason: Option<EncoderFailureReason>,
}

#[derive(Debug, Clone)]
pub enum EncoderFailureReason {
    Stalled,
    ConsecutiveProcessFailures,
    Timeout,
    TooManyEmptySamples,
}

struct EncoderHealthMonitor {
    inputs_without_output: u32,
    consecutive_process_failures: u32,
    total_frames_encoded: u64,
    last_output_time: Instant,
}

impl EncoderHealthMonitor {
    fn new() -> Self {
        Self {
            inputs_without_output: 0,
            consecutive_process_failures: 0,
            total_frames_encoded: 0,
            last_output_time: Instant::now(),
        }
    }

    fn record_input(&mut self) {
        self.inputs_without_output += 1;
    }

    fn record_output(&mut self) {
        self.inputs_without_output = 0;
        self.consecutive_process_failures = 0;
        self.total_frames_encoded += 1;
        self.last_output_time = Instant::now();
    }

    fn record_process_failure(&mut self) {
        self.consecutive_process_failures += 1;
    }

    fn reset_process_failures(&mut self) {
        self.consecutive_process_failures = 0;
    }

    fn check_health(&self) -> EncoderHealthStatus {
        let mut is_healthy = true;
        let mut failure_reason = None;

        if self.inputs_without_output > MAX_INPUT_WITHOUT_OUTPUT {
            is_healthy = false;
            failure_reason = Some(EncoderFailureReason::Stalled);
        } else if self.consecutive_process_failures >= MAX_PROCESS_INPUT_FAILURES {
            is_healthy = false;
            failure_reason = Some(EncoderFailureReason::ConsecutiveProcessFailures);
        } else if self.last_output_time.elapsed() > ENCODER_OPERATION_TIMEOUT
            && self.total_frames_encoded > 0
        {
            is_healthy = false;
            failure_reason = Some(EncoderFailureReason::Timeout);
        }

        EncoderHealthStatus {
            inputs_without_output: self.inputs_without_output,
            consecutive_process_failures: self.consecutive_process_failures,
            total_frames_encoded: self.total_frames_encoded,
            is_healthy,
            failure_reason,
        }
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

#[derive(Clone, Debug, thiserror::Error)]
pub enum HandleNeedsInputError {
    #[error("ProcessTexture: {0}")]
    ProcessTexture(windows::core::Error),
    #[error("CreateSurfaceBuffer: {0}")]
    CreateSurfaceBuffer(windows::core::Error),
    #[error("CreateSample: {0}")]
    CreateSample(windows::core::Error),
    #[error("AddBuffer: {0}")]
    AddBuffer(windows::core::Error),
    #[error("SetSampleTime: {0}")]
    SetSampleTime(windows::core::Error),
    #[error("ProcessInput: {0}")]
    ProcessInput(windows::core::Error),
}

#[derive(Clone, Debug, thiserror::Error)]
pub enum EncoderRuntimeError {
    #[error("Windows error: {0}")]
    Windows(windows::core::Error),
    #[error(
        "Encoder unhealthy: {reason:?} (inputs_without_output={inputs_without_output}, process_failures={process_failures}, frames_encoded={frames_encoded})"
    )]
    EncoderUnhealthy {
        reason: EncoderFailureReason,
        inputs_without_output: u32,
        process_failures: u32,
        frames_encoded: u64,
    },
}

impl EncoderRuntimeError {
    pub fn should_fallback(&self) -> bool {
        match self {
            EncoderRuntimeError::Windows(_) => false,
            EncoderRuntimeError::EncoderUnhealthy { .. } => true,
        }
    }
}

impl From<windows::core::Error> for EncoderRuntimeError {
    fn from(err: windows::core::Error) -> Self {
        EncoderRuntimeError::Windows(err)
    }
}

unsafe impl Send for H264Encoder {}

impl H264Encoder {
    #[allow(clippy::too_many_arguments)]
    fn new_with_scaled_output_with_flags(
        d3d_device: &ID3D11Device,
        format: DXGI_FORMAT,
        input_resolution: SizeInt32,
        output_resolution: SizeInt32,
        frame_rate: u32,
        bitrate_multipler: f32,
        flags: MFT_ENUM_FLAG,
        enable_hardware_transforms: bool,
    ) -> Result<Self, NewVideoEncoderError> {
        let bitrate = calculate_bitrate(
            output_resolution.Width as u32,
            output_resolution.Height as u32,
            frame_rate,
            bitrate_multipler,
        );

        let transform =
            EncoderDevice::enumerate_with_flags(MFMediaType_Video, MFVideoFormat_H264, flags)
                .map_err(|_| NewVideoEncoderError::NoVideoEncoderDevice)?
                .first()
                .cloned()
                .ok_or(NewVideoEncoderError::NoVideoEncoderDevice)?
                .create_transform()
                .map_err(NewVideoEncoderError::EncoderTransform)?;

        let video_processor = VideoProcessor::new(
            d3d_device.clone(),
            format,
            input_resolution,
            DXGI_FORMAT_NV12,
            output_resolution,
            frame_rate,
        )
        .map_err(NewVideoEncoderError::VideoProcessor)?;

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
            media_device_manager.expect("Device manager unexpectedly None")
        };
        unsafe {
            media_device_manager
                .ResetDevice(d3d_device, device_manager_reset_token)
                .map_err(NewVideoEncoderError::DeviceManager)?
        };

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
                .SetUINT32(
                    &MF_READWRITE_ENABLE_HARDWARE_TRANSFORMS,
                    enable_hardware_transforms as u32,
                )
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

        unsafe {
            let temp = media_device_manager.clone();
            transform
                .ProcessMessage(
                    MFT_MESSAGE_SET_D3D_MANAGER,
                    std::mem::transmute::<IMFDXGIDeviceManager, usize>(temp),
                )
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
                output_resolution.Width as u32,
                output_resolution.Height as u32,
            )?;
            MFSetAttributeRatio(&attributes, &MF_MT_FRAME_RATE, frame_rate, 1)?;
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
                if let Err(error) = &result
                    && error.code() == MF_E_NO_MORE_TYPES
                {
                    break Ok(None);
                }

                let input_type = result?;
                let attributes: IMFAttributes = input_type.cast()?;
                input_type.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video)?;
                input_type.SetGUID(&MF_MT_SUBTYPE, &MFVideoFormat_NV12)?;
                MFSetAttributeSize(
                    &attributes,
                    &MF_MT_FRAME_SIZE,
                    output_resolution.Width as u32,
                    output_resolution.Height as u32,
                )?;
                MFSetAttributeRatio(&attributes, &MF_MT_FRAME_RATE, frame_rate, 1)?;
                let result = transform.SetInputType(
                    input_stream_id,
                    &input_type,
                    MFT_SET_TYPE_TEST_ONLY.0 as u32,
                );
                if let Err(error) = &result
                    && error.code() == MF_E_INVALIDMEDIATYPE
                {
                    count += 1;
                    continue;
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

    pub fn new_with_scaled_output(
        d3d_device: &ID3D11Device,
        format: DXGI_FORMAT,
        input_resolution: SizeInt32,
        output_resolution: SizeInt32,
        frame_rate: u32,
        bitrate_multipler: f32,
    ) -> Result<Self, NewVideoEncoderError> {
        Self::new_with_scaled_output_with_flags(
            d3d_device,
            format,
            input_resolution,
            output_resolution,
            frame_rate,
            bitrate_multipler,
            MFT_ENUM_FLAG_HARDWARE | MFT_ENUM_FLAG_TRANSCODE_ONLY,
            true,
        )
    }

    pub fn new_with_scaled_output_software(
        d3d_device: &ID3D11Device,
        format: DXGI_FORMAT,
        input_resolution: SizeInt32,
        output_resolution: SizeInt32,
        frame_rate: u32,
        bitrate_multipler: f32,
    ) -> Result<Self, NewVideoEncoderError> {
        Self::new_with_scaled_output_with_flags(
            d3d_device,
            format,
            input_resolution,
            output_resolution,
            frame_rate,
            bitrate_multipler,
            MFT_ENUM_FLAG_TRANSCODE_ONLY,
            false,
        )
    }

    pub fn new(
        d3d_device: &ID3D11Device,
        format: DXGI_FORMAT,
        resolution: SizeInt32,
        frame_rate: u32,
        bitrate_multipler: f32,
    ) -> Result<Self, NewVideoEncoderError> {
        Self::new_with_scaled_output(
            d3d_device,
            format,
            resolution,
            resolution,
            frame_rate,
            bitrate_multipler,
        )
    }

    pub fn new_software(
        d3d_device: &ID3D11Device,
        format: DXGI_FORMAT,
        resolution: SizeInt32,
        frame_rate: u32,
        bitrate_multipler: f32,
    ) -> Result<Self, NewVideoEncoderError> {
        Self::new_with_scaled_output_software(
            d3d_device,
            format,
            resolution,
            resolution,
            frame_rate,
            bitrate_multipler,
        )
    }

    pub fn bitrate(&self) -> u32 {
        self.bitrate
    }

    pub fn output_type(&self) -> &IMFMediaType {
        &self.output_type
    }

    pub fn validate(&self) -> Result<(), NewVideoEncoderError> {
        unsafe {
            self.transform
                .ProcessMessage(MFT_MESSAGE_COMMAND_FLUSH, 0)
                .map_err(NewVideoEncoderError::EncoderTransform)?;

            self.transform
                .ProcessMessage(MFT_MESSAGE_NOTIFY_BEGIN_STREAMING, 0)
                .map_err(NewVideoEncoderError::EncoderTransform)?;

            self.transform
                .ProcessMessage(MFT_MESSAGE_NOTIFY_END_STREAMING, 0)
                .map_err(NewVideoEncoderError::EncoderTransform)?;

            self.transform
                .ProcessMessage(MFT_MESSAGE_COMMAND_FLUSH, 0)
                .map_err(NewVideoEncoderError::EncoderTransform)?;
        }
        Ok(())
    }

    pub fn run(
        &mut self,
        should_stop: Arc<AtomicBool>,
        mut get_frame: impl FnMut() -> windows::core::Result<Option<(ID3D11Texture2D, TimeSpan)>>,
        mut on_sample: impl FnMut(IMFSample) -> windows::core::Result<()>,
    ) -> Result<EncoderHealthStatus, EncoderRuntimeError> {
        let mut health_monitor = EncoderHealthMonitor::new();

        unsafe {
            self.transform
                .ProcessMessage(MFT_MESSAGE_COMMAND_FLUSH, 0)?;
            self.transform
                .ProcessMessage(MFT_MESSAGE_NOTIFY_BEGIN_STREAMING, 0)?;
            self.transform
                .ProcessMessage(MFT_MESSAGE_NOTIFY_START_OF_STREAM, 0)?;

            let mut consecutive_empty_samples: u8 = 0;
            let mut should_exit = false;
            while !should_exit {
                let health_status = health_monitor.check_health();
                if !health_status.is_healthy
                    && let Some(reason) = health_status.failure_reason
                {
                    let _ = self.cleanup_encoder();
                    return Err(EncoderRuntimeError::EncoderUnhealthy {
                        reason,
                        inputs_without_output: health_status.inputs_without_output,
                        process_failures: health_status.consecutive_process_failures,
                        frames_encoded: health_status.total_frames_encoded,
                    });
                }

                let event = self.event_generator.GetEvent(MF_EVENT_FLAG_NONE)?;

                let event_type = MF_EVENT_TYPE(event.GetType()? as i32);
                match event_type {
                    MediaFoundation::METransformNeedInput => {
                        health_monitor.record_input();
                        should_exit = true;
                        if !should_stop.load(Ordering::SeqCst)
                            && let Some((texture, timestamp)) = get_frame()?
                        {
                            let process_result = (|| -> windows::core::Result<()> {
                                self.video_processor.process_texture(&texture)?;
                                let input_buffer = MFCreateDXGISurfaceBuffer(
                                    &ID3D11Texture2D::IID,
                                    self.video_processor.output_texture(),
                                    0,
                                    false,
                                )?;
                                let mf_sample = MFCreateSample()?;
                                mf_sample.AddBuffer(&input_buffer)?;
                                mf_sample.SetSampleTime(timestamp.Duration)?;
                                self.transform
                                    .ProcessInput(self.input_stream_id, &mf_sample, 0)?;
                                Ok(())
                            })();

                            match process_result {
                                Ok(()) => {
                                    health_monitor.reset_process_failures();
                                    should_exit = false;
                                }
                                Err(_) => {
                                    health_monitor.record_process_failure();
                                    let health_status = health_monitor.check_health();
                                    if !health_status.is_healthy
                                        && let Some(reason) = health_status.failure_reason
                                    {
                                        let _ = self.cleanup_encoder();
                                        return Err(EncoderRuntimeError::EncoderUnhealthy {
                                            reason,
                                            inputs_without_output: health_status
                                                .inputs_without_output,
                                            process_failures: health_status
                                                .consecutive_process_failures,
                                            frames_encoded: health_status.total_frames_encoded,
                                        });
                                    }
                                    should_exit = false;
                                }
                            }
                        }
                    }
                    MediaFoundation::METransformHaveOutput => {
                        let mut status = 0;
                        let output_buffer = MFT_OUTPUT_DATA_BUFFER {
                            dwStreamID: self.output_stream_id,
                            ..Default::default()
                        };

                        let mut output_buffers = [output_buffer];
                        self.transform
                            .ProcessOutput(0, &mut output_buffers, &mut status)?;

                        if let Some(sample) = output_buffers[0].pSample.take() {
                            consecutive_empty_samples = 0;
                            health_monitor.record_output();
                            on_sample(sample)?;
                        } else {
                            consecutive_empty_samples += 1;
                            if consecutive_empty_samples > MAX_CONSECUTIVE_EMPTY_SAMPLES {
                                let _ = self.cleanup_encoder();
                                return Err(EncoderRuntimeError::EncoderUnhealthy {
                                    reason: EncoderFailureReason::TooManyEmptySamples,
                                    inputs_without_output: health_monitor.inputs_without_output,
                                    process_failures: health_monitor.consecutive_process_failures,
                                    frames_encoded: health_monitor.total_frames_encoded,
                                });
                            }
                        }
                    }
                    _ => {
                        panic!("Unknown media event type: {}", event_type.0);
                    }
                }
            }

            self.transform
                .ProcessMessage(MFT_MESSAGE_NOTIFY_END_OF_STREAM, 0)?;
            self.transform
                .ProcessMessage(MFT_MESSAGE_NOTIFY_END_STREAMING, 0)?;
            self.transform
                .ProcessMessage(MFT_MESSAGE_COMMAND_FLUSH, 0)?;
        }

        Ok(health_monitor.check_health())
    }

    fn cleanup_encoder(&mut self) -> windows::core::Result<()> {
        unsafe {
            let _ = self
                .transform
                .ProcessMessage(MFT_MESSAGE_NOTIFY_END_OF_STREAM, 0);
            let _ = self
                .transform
                .ProcessMessage(MFT_MESSAGE_NOTIFY_END_STREAMING, 0);
            self.transform.ProcessMessage(MFT_MESSAGE_COMMAND_FLUSH, 0)
        }
    }
}

fn calculate_bitrate(width: u32, height: u32, fps: u32, multiplier: f32) -> u32 {
    let frame_rate_factor = (fps as f32 - 30.0).max(0.0) / 2.0 + 30.0;
    (width as f32 * height as f32 * frame_rate_factor * multiplier) as u32
}
