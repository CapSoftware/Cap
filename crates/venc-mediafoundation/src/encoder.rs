use std::{
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    thread::JoinHandle,
};
use windows::{
    Foundation::TimeSpan,
    Graphics::SizeInt32,
    Win32::{
        Foundation::E_NOTIMPL,
        Graphics::Direct3D11::{ID3D11Device, ID3D11Texture2D},
        Media::MediaFoundation::{
            IMFAttributes, IMFDXGIDeviceManager, IMFMediaEventGenerator, IMFMediaType, IMFSample,
            IMFTransform, MEDIA_EVENT_GENERATOR_GET_EVENT_FLAGS, METransformHaveOutput,
            METransformNeedInput, MF_E_INVALIDMEDIATYPE, MF_E_NO_MORE_TYPES,
            MF_E_TRANSFORM_TYPE_NOT_SET, MF_EVENT_TYPE, MF_MT_ALL_SAMPLES_INDEPENDENT,
            MF_MT_AVG_BITRATE, MF_MT_FRAME_RATE, MF_MT_FRAME_SIZE, MF_MT_INTERLACE_MODE,
            MF_MT_MAJOR_TYPE, MF_MT_PIXEL_ASPECT_RATIO, MF_MT_SUBTYPE,
            MF_READWRITE_ENABLE_HARDWARE_TRANSFORMS, MF_TRANSFORM_ASYNC_UNLOCK,
            MFCreateDXGIDeviceManager, MFCreateDXGISurfaceBuffer, MFCreateMediaType,
            MFCreateSample, MFMediaType_Video, MFSTARTUP_FULL, MFStartup,
            MFT_MESSAGE_COMMAND_FLUSH, MFT_MESSAGE_NOTIFY_BEGIN_STREAMING,
            MFT_MESSAGE_NOTIFY_END_OF_STREAM, MFT_MESSAGE_NOTIFY_END_STREAMING,
            MFT_MESSAGE_NOTIFY_START_OF_STREAM, MFT_MESSAGE_SET_D3D_MANAGER,
            MFT_OUTPUT_DATA_BUFFER, MFT_SET_TYPE_TEST_ONLY, MFVideoFormat_H264, MFVideoFormat_NV12,
            MFVideoInterlace_Progressive,
        },
    },
    core::{Error, Interface, Result},
};

use crate::{media::*, encoder_device::*};

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

pub struct VideoEncoder {
    inner: Option<VideoEncoderInner>,
    output_type: IMFMediaType,
    started: AtomicBool,
    should_stop: Arc<AtomicBool>,
    encoder_thread_handle: Option<JoinHandle<Result<()>>>,
}

struct VideoEncoderInner {
    _d3d_device: ID3D11Device,
    _media_device_manager: IMFDXGIDeviceManager,
    _device_manager_reset_token: u32,

    transform: IMFTransform,
    event_generator: IMFMediaEventGenerator,
    input_stream_id: u32,
    output_stream_id: u32,

    sample_requested_callback:
        Option<Box<dyn Send + FnMut() -> Result<Option<VideoEncoderInputSample>>>>,
    sample_rendered_callback: Option<Box<dyn Send + FnMut(VideoEncoderOutputSample) -> Result<()>>>,

    should_stop: Arc<AtomicBool>,
}

impl VideoEncoder {
    pub fn new(
        encoder_device: &VideoEncoderDevice,
        d3d_device: ID3D11Device,
        input_resolution: SizeInt32,
        output_resolution: SizeInt32,
        bit_rate: u32,
        frame_rate: u32,
    ) -> Result<Self> {
        let transform = encoder_device.create_transform()?;

        // Create MF device manager
        let mut device_manager_reset_token: u32 = 0;
        let media_device_manager = {
            let mut media_device_manager = None;
            unsafe {
                MFCreateDXGIDeviceManager(
                    &mut device_manager_reset_token,
                    &mut media_device_manager,
                )?
            };
            media_device_manager.unwrap()
        };
        unsafe { media_device_manager.ResetDevice(&d3d_device, device_manager_reset_token)? };

        // Setup MFTransform
        let event_generator: IMFMediaEventGenerator = transform.cast()?;
        let attributes = unsafe { transform.GetAttributes()? };
        unsafe {
            attributes.SetUINT32(&MF_TRANSFORM_ASYNC_UNLOCK, 1)?;
            attributes.SetUINT32(&MF_READWRITE_ENABLE_HARDWARE_TRANSFORMS, 1)?;
        };

        let mut number_of_input_streams = 0;
        let mut number_of_output_streams = 0;
        unsafe {
            transform.GetStreamCount(&mut number_of_input_streams, &mut number_of_output_streams)?
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
                        return Err(error);
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
            transform.ProcessMessage(MFT_MESSAGE_SET_D3D_MANAGER, std::mem::transmute(temp))?;
        };

        let output_type = unsafe {
            let output_type = MFCreateMediaType()?;
            let attributes: IMFAttributes = output_type.cast()?;
            output_type.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video)?;
            output_type.SetGUID(&MF_MT_SUBTYPE, &MFVideoFormat_H264)?;
            output_type.SetUINT32(&MF_MT_AVG_BITRATE, bit_rate)?;
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
            output_type
        };
        let input_type: Option<IMFMediaType> = unsafe {
            let mut count = 0;
            loop {
                let result = transform.GetInputAvailableType(input_stream_id, count);
                if let Err(error) = &result {
                    if error.code() == MF_E_NO_MORE_TYPES {
                        break None;
                    }
                }

                let input_type = result?;
                let attributes: IMFAttributes = input_type.cast()?;
                input_type.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video)?;
                input_type.SetGUID(&MF_MT_SUBTYPE, &MFVideoFormat_NV12)?;
                MFSetAttributeSize(
                    &attributes,
                    &MF_MT_FRAME_SIZE,
                    input_resolution.Width as u32,
                    input_resolution.Height as u32,
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
                break Some(input_type);
            }
        };
        if let Some(input_type) = input_type {
            unsafe { transform.SetInputType(input_stream_id, &input_type, 0)? };
        } else {
            return Err(Error::new(
                MF_E_TRANSFORM_TYPE_NOT_SET,
                "No suitable input type found! Try a different set of encoding settings.",
            ));
        }

        let should_stop = Arc::new(AtomicBool::new(false));
        let inner = VideoEncoderInner {
            _d3d_device: d3d_device,
            _media_device_manager: media_device_manager,
            _device_manager_reset_token: device_manager_reset_token,

            transform,
            event_generator,
            input_stream_id,
            output_stream_id,

            sample_requested_callback: None,
            sample_rendered_callback: None,

            should_stop: should_stop.clone(),
        };

        Ok(Self {
            inner: Some(inner),
            output_type,
            started: AtomicBool::new(false),
            should_stop,
            encoder_thread_handle: None,
        })
    }

    pub fn try_start(&mut self) -> Result<bool> {
        let mut result = false;
        if self
            .started
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_ok()
        {
            let mut inner = self.inner.take().unwrap();

            // Callbacks must both be set
            if inner.sample_rendered_callback.is_none() || inner.sample_requested_callback.is_none()
            {
                panic!("Sample requested and rendered callbacks must be set before starting");
            }

            // Start a seperate thread to drive the transform
            self.encoder_thread_handle = Some(std::thread::spawn(move || -> Result<()> {
                unsafe { MFStartup(MF_VERSION, MFSTARTUP_FULL)? }
                let result = inner.encode();
                if result.is_err() {
                    println!("Recording stopped unexpectedly!");
                }
                result
            }));
            result = true;
        }
        Ok(result)
    }

    pub fn stop(&mut self) -> Result<()> {
        if self.started.load(Ordering::SeqCst) {
            assert!(
                self.should_stop
                    .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
                    .is_ok()
            );
            self.wait_for_completion()?;
        }
        Ok(())
    }

    fn wait_for_completion(&mut self) -> Result<()> {
        let handle = self.encoder_thread_handle.take().unwrap();
        handle.join().unwrap()
    }

    pub fn set_sample_requested_callback<
        F: 'static + Send + FnMut() -> Result<Option<VideoEncoderInputSample>>,
    >(
        &mut self,
        callback: F,
    ) {
        self.inner.as_mut().unwrap().sample_requested_callback = Some(Box::new(callback));
    }

    pub fn set_sample_rendered_callback<
        F: 'static + Send + FnMut(VideoEncoderOutputSample) -> Result<()>,
    >(
        &mut self,
        callback: F,
    ) {
        self.inner.as_mut().unwrap().sample_rendered_callback = Some(Box::new(callback));
    }

    pub fn output_type(&self) -> &IMFMediaType {
        &self.output_type
    }
}

unsafe impl Send for VideoEncoderInner {}
// Workaround for:
//    warning: constant in pattern `METransformNeedInput` should have an upper case name
//       --> src\video\encoder.rs:XXX:YY
//        |
//    XXX |                     METransformNeedInput => {
//        |                     ^^^^^^^^^^^^^^^^^^^^ help: convert the identifier to upper case: `METRANSFORM_NEED_INPUT`
//        |
//        = note: `#[warn(non_upper_case_globals)]` on by default
const MEDIA_ENGINE_TRANFORM_NEED_INPUT: MF_EVENT_TYPE = METransformNeedInput;
const MEDIA_ENGINE_TRANFORM_HAVE_OUTPUT: MF_EVENT_TYPE = METransformHaveOutput;
impl VideoEncoderInner {
    fn encode(&mut self) -> Result<()> {
        unsafe {
            self.transform
                .ProcessMessage(MFT_MESSAGE_COMMAND_FLUSH, 0)?;
            self.transform
                .ProcessMessage(MFT_MESSAGE_NOTIFY_BEGIN_STREAMING, 0)?;
            self.transform
                .ProcessMessage(MFT_MESSAGE_NOTIFY_START_OF_STREAM, 0)?;

            let mut should_exit = false;
            while !should_exit {
                let event = self
                    .event_generator
                    .GetEvent(MEDIA_EVENT_GENERATOR_GET_EVENT_FLAGS(0))?;

                let event_type = MF_EVENT_TYPE(event.GetType()? as i32);
                dbg!(&event_type);
                match event_type {
                    MEDIA_ENGINE_TRANFORM_NEED_INPUT => {
                        should_exit = self.on_transform_input_requested()?;
                    }
                    MEDIA_ENGINE_TRANFORM_HAVE_OUTPUT => {
                        self.on_transform_output_ready()?;
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
        Ok(())
    }

    fn on_transform_input_requested(&mut self) -> Result<bool> {
        let mut should_exit = true;
        if !self.should_stop.load(Ordering::SeqCst) {
            if let Some(sample) = self.sample_requested_callback.as_mut().unwrap()()? {
                let input_buffer = unsafe {
                    MFCreateDXGISurfaceBuffer(&ID3D11Texture2D::IID, &sample.texture, 0, false)?
                };
                let mf_sample = unsafe { MFCreateSample()? };
                unsafe {
                    mf_sample.AddBuffer(&input_buffer)?;
                    mf_sample.SetSampleTime(sample.timestamp.Duration)?;
                    self.transform
                        .ProcessInput(self.input_stream_id, &mf_sample, 0)?;
                };
                should_exit = false;
                dbg!(should_exit);
            }
        }
        Ok(should_exit)
    }

    fn on_transform_output_ready(&mut self) -> Result<()> {
        let mut status = 0;
        let output_buffer = MFT_OUTPUT_DATA_BUFFER {
            dwStreamID: self.output_stream_id,
            ..Default::default()
        };

        let sample = unsafe {
            let mut output_buffers = [output_buffer];
            self.transform
                .ProcessOutput(0, &mut output_buffers, &mut status)?;
            output_buffers[0].pSample.as_ref().unwrap().clone()
        };

        let output_sample = VideoEncoderOutputSample { sample };
        self.sample_rendered_callback.as_mut().unwrap()(output_sample)?;
        Ok(())
    }
}
