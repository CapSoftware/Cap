fn main() {
    #[cfg(windows)]
    windows::main();
}

#[cfg(windows)]
mod windows {
    use ::windows::Graphics::SizeInt32;
    use ::windows::Storage::FileAccessMode;
    use ::windows::Win32::Media::MediaFoundation::{MFSTARTUP_FULL, MFStartup};
    use ::windows::Win32::System::WinRT::{RO_INIT_MULTITHREADED, RoInitialize};
    use ::windows::Win32::UI::WindowsAndMessaging::{
        DispatchMessageW, GetMessageW, MSG, WM_HOTKEY,
    };
    use ::windows::{
        Storage::{CreationCollisionOption, StorageFolder},
        Win32::{Foundation::MAX_PATH, Storage::FileSystem::GetFullPathNameW},
        core::HSTRING,
    };
    use cap_displays::*;
    use scap_direct3d::{Capturer, PixelFormat, Settings};
    use std::time::Instant;
    use std::{path::Path, sync::Arc, time::Duration};

    use super::*;

    pub fn main() {
        unsafe {
            RoInitialize(RO_INIT_MULTITHREADED).unwrap();
        }
        unsafe { MFStartup(MF_VERSION, MFSTARTUP_FULL).unwrap() }

        let display = Display::primary();
        let display = display.raw_handle();

        let (frame_tx, frame_rx) = std::sync::mpsc::channel();

        let mut capturer = Capturer::new(
            display.try_as_capture_item().unwrap(),
            Settings {
                is_border_required: Some(true),
                is_cursor_capture_enabled: Some(true),
                pixel_format: PixelFormat::R8G8B8A8Unorm,
                // crop: Some(D3D11_BOX {
                //     left: 0,
                //     top: 0,
                //     right: 500,
                //     bottom: 400,
                //     front: 0,
                //     back: 1,
                // }),
                ..Default::default()
            },
        )
        .unwrap();

        let mut encoder_devices = VideoEncoderDevice::enumerate().unwrap();
        let encoder_device = encoder_devices.swap_remove(0);

        let mut video_encoder = VideoEncoder::new(
            &encoder_device,
            capturer.d3d_device().clone(),
            SizeInt32 {
                Width: 3340,
                Height: 1440,
            },
            SizeInt32 {
                Width: 3340,
                Height: 1440,
            },
            12_000_000,
            60,
        )
        .unwrap();
        let output_type = video_encoder.output_type().clone();

        // Create our file
        let path = unsafe {
            let mut new_path = vec![0u16; MAX_PATH as usize];
            let length =
                GetFullPathNameW(&HSTRING::from("recording.mp4"), Some(&mut new_path), None);
            new_path.resize(length as usize, 0);
            String::from_utf16(&new_path).unwrap()
        };
        let path = Path::new(&path);
        let parent_folder_path = path.parent().unwrap();
        let parent_folder = StorageFolder::GetFolderFromPathAsync(&HSTRING::from(
            parent_folder_path.as_os_str().to_str().unwrap(),
        ))
        .unwrap()
        .get()
        .unwrap();
        let file_name = path.file_name().unwrap();
        let file = parent_folder
            .CreateFileAsync(
                &HSTRING::from(file_name.to_str().unwrap()),
                CreationCollisionOption::ReplaceExisting,
            )
            .unwrap()
            .get()
            .unwrap();

        let stream = file
            .OpenAsync(FileAccessMode::ReadWrite)
            .unwrap()
            .get()
            .unwrap();

        video_encoder.set_sample_requested_callback(move || Ok(frame_rx.recv().ok()));

        let sample_writer = Arc::new(SampleWriter::new(stream, &output_type).unwrap());
        video_encoder.set_sample_rendered_callback({
            let sample_writer = sample_writer.clone();
            move |sample| {
                dbg!(sample.sample());
                sample_writer.write(sample.sample())
            }
        });

        sample_writer.start().unwrap();

        let mut first_timestamp = None;

        capturer
            .start(
                move |frame| {
                    let frame_time = frame.inner().SystemRelativeTime().unwrap();

                    let first_timestamp = first_timestamp.get_or_insert(frame_time);

                    let _ = frame_tx.send(VideoEncoderInputSample::new(
                        ::windows::Foundation::TimeSpan {
                            Duration: frame_time.Duration - first_timestamp.Duration,
                        },
                        frame.texture().clone(),
                    ));
                    // dbg!(&frame);

                    // let ff_frame = frame.as_ffmpeg()?;
                    // dbg!(ff_frame.width(), ff_frame.height(), ff_frame.format());

                    Ok(())
                },
                || Ok(()),
            )
            .unwrap();

        video_encoder.try_start().unwrap();

        std::thread::sleep(Duration::from_secs(10));

        video_encoder.stop().unwrap();
        sample_writer.stop().unwrap();
        capturer.stop().unwrap();

        // std::thread::sleep(Duration::from_secs(3));
    }

    fn pump_messages() -> ::windows::core::Result<()> {
        // let _hot_key = HotKey::new(MOD_SHIFT | MOD_CONTROL, 0x52 /* R */)?;
        // println!("Press SHIFT+CTRL+R to start/stop the recording...");
        let start = Instant::now();
        unsafe {
            let mut message = MSG::default();
            while GetMessageW(&mut message, None, 0, 0).into() {
                dbg!(message.message);
                if start.elapsed().as_secs_f64() > 3.0 {
                    break;
                }
                DispatchMessageW(&message);
            }
        }
        Ok(())
    }
}

use encoder::*;
mod encoder {
    use std::{
        sync::{
            Arc,
            atomic::{AtomicBool, Ordering},
        },
        thread::JoinHandle,
    };

    use ::windows::{
        Foundation::TimeSpan,
        Graphics::SizeInt32,
        Win32::{
            Foundation::E_NOTIMPL,
            Graphics::Direct3D11::{ID3D11Device, ID3D11Texture2D},
            Media::MediaFoundation::{
                IMFAttributes, IMFDXGIDeviceManager, IMFMediaEventGenerator, IMFMediaType,
                IMFSample, IMFTransform, MEDIA_EVENT_GENERATOR_GET_EVENT_FLAGS,
                METransformHaveOutput, METransformNeedInput, MF_E_INVALIDMEDIATYPE,
                MF_E_NO_MORE_TYPES, MF_E_TRANSFORM_TYPE_NOT_SET, MF_EVENT_TYPE,
                MF_MT_ALL_SAMPLES_INDEPENDENT, MF_MT_AVG_BITRATE, MF_MT_FRAME_RATE,
                MF_MT_FRAME_SIZE, MF_MT_INTERLACE_MODE, MF_MT_MAJOR_TYPE, MF_MT_PIXEL_ASPECT_RATIO,
                MF_MT_SUBTYPE, MF_READWRITE_ENABLE_HARDWARE_TRANSFORMS, MF_TRANSFORM_ASYNC_UNLOCK,
                MFCreateDXGIDeviceManager, MFCreateDXGISurfaceBuffer, MFCreateMediaType,
                MFCreateSample, MFMediaType_Video, MFSTARTUP_FULL, MFStartup,
                MFT_MESSAGE_COMMAND_FLUSH, MFT_MESSAGE_NOTIFY_BEGIN_STREAMING,
                MFT_MESSAGE_NOTIFY_END_OF_STREAM, MFT_MESSAGE_NOTIFY_END_STREAMING,
                MFT_MESSAGE_NOTIFY_START_OF_STREAM, MFT_MESSAGE_SET_D3D_MANAGER,
                MFT_OUTPUT_DATA_BUFFER, MFT_SET_TYPE_TEST_ONLY, MFVideoFormat_H264,
                MFVideoFormat_NV12, MFVideoInterlace_Progressive,
            },
        },
        core::{Error, Interface, Result},
    };

    use super::*;

    // use crate::media::{MF_VERSION, MFSetAttributeRatio, MFSetAttributeSize};

    // use super::encoder_device::VideoEncoderDevice;

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
        sample_rendered_callback:
            Option<Box<dyn Send + FnMut(VideoEncoderOutputSample) -> Result<()>>>,

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
                transform
                    .GetStreamCount(&mut number_of_input_streams, &mut number_of_output_streams)?
            };
            let (input_stream_ids, output_stream_ids) = {
                let mut input_stream_ids = vec![0u32; number_of_input_streams as usize];
                let mut output_stream_ids = vec![0u32; number_of_output_streams as usize];
                let result = unsafe {
                    transform.GetStreamIDs(&mut input_stream_ids, &mut output_stream_ids)
                };
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
                output_type
                    .SetUINT32(&MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive.0 as u32)?;
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
                if inner.sample_rendered_callback.is_none()
                    || inner.sample_requested_callback.is_none()
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
}

use encoder_device::*;
mod encoder_device {
    use ::windows::{
        Win32::Media::MediaFoundation::{
            IMFActivate, IMFTransform, MFMediaType_Video, MFT_CATEGORY_VIDEO_ENCODER,
            MFT_ENUM_FLAG_HARDWARE, MFT_ENUM_FLAG_SORTANDFILTER, MFT_ENUM_FLAG_TRANSCODE_ONLY,
            MFT_FRIENDLY_NAME_Attribute, MFT_REGISTER_TYPE_INFO, MFVideoFormat_H264,
        },
        core::{Interface, Result},
    };

    use super::*;

    #[derive(Clone)]
    pub struct VideoEncoderDevice {
        source: IMFActivate,
        display_name: String,
    }

    impl VideoEncoderDevice {
        pub fn enumerate() -> Result<Vec<VideoEncoderDevice>> {
            let output_info = MFT_REGISTER_TYPE_INFO {
                guidMajorType: MFMediaType_Video,
                guidSubtype: MFVideoFormat_H264,
            };
            let encoders = enumerate_mfts(
                &MFT_CATEGORY_VIDEO_ENCODER,
                MFT_ENUM_FLAG_HARDWARE | MFT_ENUM_FLAG_TRANSCODE_ONLY | MFT_ENUM_FLAG_SORTANDFILTER,
                None,
                Some(&output_info),
            )?;
            let mut encoder_devices = Vec::new();
            for encoder in encoders {
                let display_name = if let Some(display_name) =
                    get_string_attribute(&encoder.cast()?, &MFT_FRIENDLY_NAME_Attribute)?
                {
                    display_name
                } else {
                    "Unknown".to_owned()
                };
                let encoder_device = VideoEncoderDevice {
                    source: encoder,
                    display_name,
                };
                encoder_devices.push(encoder_device);
            }
            Ok(encoder_devices)
        }

        pub fn display_name(&self) -> &str {
            &self.display_name
        }

        pub fn create_transform(&self) -> Result<IMFTransform> {
            unsafe { self.source.ActivateObject() }
        }
    }
}

use media::*;
mod media {
    use ::windows::{
        Win32::Media::MediaFoundation::{
            IMFActivate, IMFAttributes, MF_E_ATTRIBUTENOTFOUND, MFT_ENUM_FLAG,
            MFT_REGISTER_TYPE_INFO, MFTEnumEx,
        },
        core::{Array, GUID, Result},
    };

    use super::*;

    pub fn enumerate_mfts(
        category: &GUID,
        flags: MFT_ENUM_FLAG,
        input_type: Option<&MFT_REGISTER_TYPE_INFO>,
        output_type: Option<&MFT_REGISTER_TYPE_INFO>,
    ) -> Result<Vec<IMFActivate>> {
        let mut transform_sources = Vec::new();
        let mfactivate_list = unsafe {
            let mut data = std::ptr::null_mut();
            let mut len = 0;
            MFTEnumEx(
                *category,
                flags,
                input_type.map(|info| info as *const _),
                output_type.map(|info| info as *const _),
                &mut data,
                &mut len,
            )?;
            Array::<IMFActivate>::from_raw_parts(data as _, len)
        };
        if !mfactivate_list.is_empty() {
            for mfactivate in mfactivate_list.as_slice() {
                let transform_source = mfactivate.clone().unwrap();
                transform_sources.push(transform_source);
            }
        }
        Ok(transform_sources)
    }

    pub fn get_string_attribute(
        attributes: &IMFAttributes,
        attribute_guid: &GUID,
    ) -> Result<Option<String>> {
        unsafe {
            match attributes.GetStringLength(attribute_guid) {
                Ok(mut length) => {
                    let mut result = vec![0u16; (length + 1) as usize];
                    attributes.GetString(attribute_guid, &mut result, Some(&mut length))?;
                    result.resize(length as usize, 0);
                    Ok(Some(String::from_utf16(&result).unwrap()))
                }
                Err(error) => {
                    if error.code() == MF_E_ATTRIBUTENOTFOUND {
                        Ok(None)
                    } else {
                        Err(error)
                    }
                }
            }
        }
    }

    // These inlined helpers aren't represented in the metadata

    // This is the value for Win7+
    pub const MF_VERSION: u32 = 131184;

    fn pack_2_u32_as_u64(high: u32, low: u32) -> u64 {
        ((high as u64) << 32) | low as u64
    }

    #[allow(non_snake_case)]
    unsafe fn MFSetAttribute2UINT32asUINT64(
        attributes: &IMFAttributes,
        key: &GUID,
        high: u32,
        low: u32,
    ) -> Result<()> {
        unsafe { attributes.SetUINT64(key, pack_2_u32_as_u64(high, low)) }
    }

    #[allow(non_snake_case)]
    pub unsafe fn MFSetAttributeSize(
        attributes: &IMFAttributes,
        key: &GUID,
        width: u32,
        height: u32,
    ) -> Result<()> {
        unsafe { MFSetAttribute2UINT32asUINT64(attributes, key, width, height) }
    }

    #[allow(non_snake_case)]
    pub unsafe fn MFSetAttributeRatio(
        attributes: &IMFAttributes,
        key: &GUID,
        numerator: u32,
        denominator: u32,
    ) -> Result<()> {
        unsafe { MFSetAttribute2UINT32asUINT64(attributes, key, numerator, denominator) }
    }
}

use encoding_session::*;
mod encoding_session {

    use std::sync::Arc;

    use ::windows::{
        Foundation::TimeSpan,
        Graphics::{
            Capture::{Direct3D11CaptureFrame, GraphicsCaptureItem, GraphicsCaptureSession},
            SizeInt32,
        },
        Storage::Streams::IRandomAccessStream,
        Win32::{
            Graphics::{
                Direct3D11::{
                    D3D11_BIND_RENDER_TARGET, D3D11_BIND_SHADER_RESOURCE, D3D11_BOX,
                    D3D11_TEXTURE2D_DESC, D3D11_USAGE_DEFAULT, ID3D11Device, ID3D11DeviceContext,
                    ID3D11RenderTargetView, ID3D11Texture2D,
                },
                Dxgi::Common::{DXGI_FORMAT_B8G8R8A8_UNORM, DXGI_FORMAT_NV12, DXGI_SAMPLE_DESC},
            },
            Media::MediaFoundation::{
                IMFMediaType, IMFSample, IMFSinkWriter, MFCreateAttributes,
                MFCreateMFByteStreamOnStreamEx, MFCreateSinkWriterFromURL,
            },
            System::WinRT::Direct3D11::IDirect3DDxgiInterfaceAccess,
        },
        core::{HSTRING, Interface, Result},
    };

    use super::*;

    //     capture::CaptureFrameGenerator,
    //     d3d::get_d3d_interface_from_object,
    //     video::{
    //         CLEAR_COLOR,
    //         encoding_session::{VideoEncoderSessionFactory, VideoEncodingSession},
    //         util::ensure_even_size,
    //     },
    // };

    // use super::{
    //     encoder::{VideoEncoder, VideoEncoderInputSample},
    //     encoder_device::VideoEncoderDevice,
    //     processor::VideoProcessor,
    // };

    pub struct SampleWriter {
        _stream: IRandomAccessStream,
        sink_writer: IMFSinkWriter,
        sink_writer_stream_index: u32,
    }

    unsafe impl Send for SampleWriter {}
    unsafe impl Sync for SampleWriter {}
    impl SampleWriter {
        pub fn new(stream: IRandomAccessStream, output_type: &IMFMediaType) -> Result<Self> {
            let empty_attributes = unsafe {
                let mut attributes = None;
                MFCreateAttributes(&mut attributes, 0)?;
                attributes.unwrap()
            };
            let sink_writer = unsafe {
                let byte_stream = MFCreateMFByteStreamOnStreamEx(&stream)?;
                MFCreateSinkWriterFromURL(&HSTRING::from(".mp4"), &byte_stream, &empty_attributes)?
            };
            let sink_writer_stream_index = unsafe { sink_writer.AddStream(output_type)? };
            unsafe {
                sink_writer.SetInputMediaType(
                    sink_writer_stream_index,
                    output_type,
                    &empty_attributes,
                )?
            };

            Ok(Self {
                _stream: stream,
                sink_writer,
                sink_writer_stream_index,
            })
        }

        pub fn start(&self) -> Result<()> {
            unsafe { self.sink_writer.BeginWriting() }
        }

        pub fn stop(&self) -> Result<()> {
            unsafe { self.sink_writer.Finalize() }
        }

        pub fn write(&self, sample: &IMFSample) -> Result<()> {
            unsafe {
                self.sink_writer
                    .WriteSample(self.sink_writer_stream_index, sample)
            }
        }
    }

    pub fn get_d3d_interface_from_object<S: Interface, R: Interface>(object: &S) -> Result<R> {
        let access: IDirect3DDxgiInterfaceAccess = object.cast()?;
        let object = unsafe { access.GetInterface::<R>()? };
        Ok(object)
    }
}

use processor::*;
mod processor {
    use ::windows::{
        Graphics::{RectInt32, SizeInt32},
        Win32::{
            Foundation::RECT,
            Graphics::{
                Direct3D11::{
                    D3D11_BIND_RENDER_TARGET, D3D11_BIND_SHADER_RESOURCE, D3D11_BIND_VIDEO_ENCODER,
                    D3D11_TEX2D_VPIV, D3D11_TEX2D_VPOV, D3D11_TEXTURE2D_DESC, D3D11_USAGE_DEFAULT,
                    D3D11_VIDEO_FRAME_FORMAT_PROGRESSIVE, D3D11_VIDEO_PROCESSOR_COLOR_SPACE,
                    D3D11_VIDEO_PROCESSOR_CONTENT_DESC, D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC,
                    D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC_0,
                    D3D11_VIDEO_PROCESSOR_NOMINAL_RANGE_0_255,
                    D3D11_VIDEO_PROCESSOR_NOMINAL_RANGE_16_235,
                    D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC,
                    D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC_0, D3D11_VIDEO_PROCESSOR_STREAM,
                    D3D11_VIDEO_USAGE_OPTIMAL_QUALITY, D3D11_VPIV_DIMENSION_TEXTURE2D,
                    D3D11_VPOV_DIMENSION_TEXTURE2D, ID3D11Device, ID3D11DeviceContext,
                    ID3D11Texture2D, ID3D11VideoContext, ID3D11VideoDevice, ID3D11VideoProcessor,
                    ID3D11VideoProcessorInputView, ID3D11VideoProcessorOutputView,
                },
                Dxgi::Common::{DXGI_FORMAT, DXGI_RATIONAL, DXGI_SAMPLE_DESC},
            },
        },
        core::{Interface, Result},
    };
    use windows_numerics::Vector2;

    pub struct VideoProcessor {
        _d3d_device: ID3D11Device,
        d3d_context: ID3D11DeviceContext,

        _video_device: ID3D11VideoDevice,
        video_context: ID3D11VideoContext,
        video_processor: ID3D11VideoProcessor,
        video_output_texture: ID3D11Texture2D,
        video_output: ID3D11VideoProcessorOutputView,
        video_input_texture: ID3D11Texture2D,
        video_input: ID3D11VideoProcessorInputView,
    }

    impl VideoProcessor {
        pub fn new(
            d3d_device: ID3D11Device,
            input_format: DXGI_FORMAT,
            input_size: SizeInt32,
            output_format: DXGI_FORMAT,
            output_size: SizeInt32,
        ) -> Result<Self> {
            let d3d_context = unsafe { d3d_device.GetImmediateContext()? };

            // Setup video conversion
            let video_device: ID3D11VideoDevice = d3d_device.cast()?;
            let video_context: ID3D11VideoContext = d3d_context.cast()?;

            let video_desc = D3D11_VIDEO_PROCESSOR_CONTENT_DESC {
                InputFrameFormat: D3D11_VIDEO_FRAME_FORMAT_PROGRESSIVE,
                InputFrameRate: DXGI_RATIONAL {
                    Numerator: 60,
                    Denominator: 1,
                },
                InputWidth: input_size.Width as u32,
                InputHeight: input_size.Height as u32,
                OutputFrameRate: DXGI_RATIONAL {
                    Numerator: 60,
                    Denominator: 1,
                },
                OutputWidth: input_size.Width as u32,
                OutputHeight: input_size.Height as u32,
                Usage: D3D11_VIDEO_USAGE_OPTIMAL_QUALITY,
            };
            let video_enum = unsafe { video_device.CreateVideoProcessorEnumerator(&video_desc)? };

            let video_processor = unsafe { video_device.CreateVideoProcessor(&video_enum, 0)? };

            let mut color_space = D3D11_VIDEO_PROCESSOR_COLOR_SPACE {
                _bitfield: 1 | (D3D11_VIDEO_PROCESSOR_NOMINAL_RANGE_16_235.0 as u32) << 4, // Usage: 1 (Video processing), Nominal_Range: D3D11_VIDEO_PROCESSOR_NOMINAL_RANGE_16_235
            };
            unsafe {
                video_context.VideoProcessorSetOutputColorSpace(&video_processor, &color_space)
            };
            color_space._bitfield = 1 | (D3D11_VIDEO_PROCESSOR_NOMINAL_RANGE_0_255.0 as u32) << 4; // Usage: 1 (Video processing), Nominal_Range: D3D11_VIDEO_PROCESSOR_NOMINAL_RANGE_0_255
            unsafe {
                video_context.VideoProcessorSetStreamColorSpace(&video_processor, 0, &color_space)
            };

            // If the input and output resolutions don't match, setup the
            // video processor to preserve the aspect ratio when scaling.
            if input_size.Width != output_size.Width || input_size.Height != output_size.Height {
                let dest_rect = compute_dest_rect(&output_size, &input_size);
                let rect = RECT {
                    left: dest_rect.X,
                    top: dest_rect.Y,
                    right: dest_rect.X + dest_rect.Width,
                    bottom: dest_rect.Y + dest_rect.Height,
                };
                unsafe {
                    video_context.VideoProcessorSetStreamDestRect(
                        &video_processor,
                        0,
                        true,
                        Some(&rect),
                    )
                };
            }

            let mut texture_desc = D3D11_TEXTURE2D_DESC {
                Width: output_size.Width as u32,
                Height: output_size.Height as u32,
                ArraySize: 1,
                MipLevels: 1,
                Format: output_format,
                SampleDesc: DXGI_SAMPLE_DESC {
                    Count: 1,
                    ..Default::default()
                },
                Usage: D3D11_USAGE_DEFAULT,
                BindFlags: (D3D11_BIND_RENDER_TARGET.0 | D3D11_BIND_VIDEO_ENCODER.0) as u32,
                ..Default::default()
            };
            let video_output_texture = unsafe {
                let mut texture = None;
                d3d_device.CreateTexture2D(&texture_desc, None, Some(&mut texture))?;
                texture.unwrap()
            };

            let output_view_desc = D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC {
                ViewDimension: D3D11_VPOV_DIMENSION_TEXTURE2D,
                Anonymous: D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC_0 {
                    Texture2D: D3D11_TEX2D_VPOV { MipSlice: 0 },
                },
            };
            let video_output = unsafe {
                let mut output = None;
                video_device.CreateVideoProcessorOutputView(
                    &video_output_texture,
                    &video_enum,
                    &output_view_desc,
                    Some(&mut output),
                )?;
                output.unwrap()
            };

            texture_desc.Width = input_size.Width as u32;
            texture_desc.Height = input_size.Height as u32;
            texture_desc.Format = input_format;
            texture_desc.BindFlags =
                (D3D11_BIND_RENDER_TARGET.0 | D3D11_BIND_SHADER_RESOURCE.0) as u32;
            let video_input_texture = unsafe {
                let mut texture = None;
                d3d_device.CreateTexture2D(&texture_desc, None, Some(&mut texture))?;
                texture.unwrap()
            };

            let input_view_desc = D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC {
                ViewDimension: D3D11_VPIV_DIMENSION_TEXTURE2D,
                Anonymous: D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC_0 {
                    Texture2D: D3D11_TEX2D_VPIV {
                        MipSlice: 0,
                        ..Default::default()
                    },
                },
                ..Default::default()
            };
            let video_input = unsafe {
                let mut input = None;
                video_device.CreateVideoProcessorInputView(
                    &video_input_texture,
                    &video_enum,
                    &input_view_desc,
                    Some(&mut input),
                )?;
                input.unwrap()
            };

            Ok(Self {
                _d3d_device: d3d_device,
                d3d_context,

                _video_device: video_device,
                video_context,
                video_processor,
                video_output_texture,
                video_output,
                video_input_texture,
                video_input,
            })
        }

        pub fn output_texture(&self) -> &ID3D11Texture2D {
            &self.video_output_texture
        }

        pub fn process_texture(&mut self, input_texture: &ID3D11Texture2D) -> Result<()> {
            // The caller is responsible for making sure they give us a
            // texture that matches the input size we were initialized with.

            unsafe {
                // Copy the texture to the video input texture
                self.d3d_context
                    .CopyResource(&self.video_input_texture, input_texture);

                // Convert to NV12
                let video_stream = D3D11_VIDEO_PROCESSOR_STREAM {
                    Enable: true.into(),
                    OutputIndex: 0,
                    InputFrameOrField: 0,
                    pInputSurface: std::mem::transmute_copy(&self.video_input),
                    ..Default::default()
                };
                self.video_context.VideoProcessorBlt(
                    &self.video_processor,
                    &self.video_output,
                    0,
                    &[video_stream],
                )
            }
        }
    }

    fn compute_scale_factor(output_size: Vector2, input_size: Vector2) -> f32 {
        let output_ratio = output_size.X / output_size.Y;
        let input_ratio = input_size.X / input_size.Y;

        let mut scale_factor = output_size.X / input_size.X;
        if output_ratio > input_ratio {
            scale_factor = output_size.Y / input_size.Y;
        }

        scale_factor
    }

    fn compute_dest_rect(output_size: &SizeInt32, input_size: &SizeInt32) -> RectInt32 {
        let scale = compute_scale_factor(
            Vector2 {
                X: output_size.Width as f32,
                Y: output_size.Height as f32,
            },
            Vector2 {
                X: input_size.Width as f32,
                Y: input_size.Height as f32,
            },
        );
        let new_size = SizeInt32 {
            Width: (input_size.Width as f32 * scale) as i32,
            Height: (input_size.Height as f32 * scale) as i32,
        };
        let mut offset_x = 0;
        let mut offset_y = 0;
        if new_size.Width != output_size.Width {
            offset_x = (output_size.Width - new_size.Width) / 2;
        }
        if new_size.Height != output_size.Height {
            offset_y = (output_size.Height - new_size.Height) / 2;
        }
        RectInt32 {
            X: offset_x,
            Y: offset_y,
            Width: new_size.Width,
            Height: new_size.Height,
        }
    }
}
