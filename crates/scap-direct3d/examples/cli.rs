fn main() {
    #[cfg(windows)]
    let _ = windows::main();
}

#[cfg(windows)]
mod windows {
    use ::windows::{
        Win32::Media::MediaFoundation::{
            IMFActivate, IMFAttributes, IMFTransform, MF_E_ATTRIBUTENOTFOUND, MFMediaType_Video,
            MFT_CATEGORY_VIDEO_ENCODER, MFT_ENUM_FLAG, MFT_ENUM_FLAG_HARDWARE,
            MFT_ENUM_FLAG_SORTANDFILTER, MFT_ENUM_FLAG_TRANSCODE_ONLY, MFT_FRIENDLY_NAME_Attribute,
            MFT_REGISTER_TYPE_INFO, MFTEnumEx, MFVideoFormat_H264,
        },
        core::{Array, GUID, Interface},
    };
    use scap_direct3d::{Capturer, PixelFormat, Settings};
    use scap_ffmpeg::*;
    use scap_targets::*;
    use std::time::Duration;
    use windows::{
        Foundation::TimeSpan,
        Graphics::SizeInt32,
        Win32::{
            Foundation::E_NOTIMPL,
            Graphics::Direct3D11::ID3D11Texture2D,
            Media::MediaFoundation::{
                self, IMFMediaEventGenerator, IMFMediaType, MEDIA_EVENT_GENERATOR_GET_EVENT_FLAGS,
                METransformHaveOutput, METransformNeedInput, MF_E_INVALIDMEDIATYPE,
                MF_E_NO_MORE_TYPES, MF_E_TRANSFORM_TYPE_NOT_SET, MF_EVENT_TYPE,
                MF_MT_ALL_SAMPLES_INDEPENDENT, MF_MT_AVG_BITRATE, MF_MT_FRAME_RATE,
                MF_MT_FRAME_SIZE, MF_MT_INTERLACE_MODE, MF_MT_MAJOR_TYPE, MF_MT_PIXEL_ASPECT_RATIO,
                MF_MT_SUBTYPE, MF_READWRITE_ENABLE_HARDWARE_TRANSFORMS, MF_TRANSFORM_ASYNC_UNLOCK,
                MF_VERSION, MFCreateDXGIDeviceManager, MFCreateDXGISurfaceBuffer,
                MFCreateMediaType, MFCreateSample, MFSTARTUP_FULL, MFStartup,
                MFT_MESSAGE_COMMAND_FLUSH, MFT_MESSAGE_NOTIFY_BEGIN_STREAMING,
                MFT_MESSAGE_NOTIFY_END_OF_STREAM, MFT_MESSAGE_NOTIFY_END_STREAMING,
                MFT_MESSAGE_NOTIFY_START_OF_STREAM, MFT_MESSAGE_SET_D3D_MANAGER,
                MFT_OUTPUT_DATA_BUFFER, MFT_SET_TYPE_TEST_ONLY, MFVideoFormat_NV12,
                MFVideoInterlace_Progressive,
            },
            System::WinRT::{RO_INIT_MULTITHREADED, RoInitialize},
            UI::WindowsAndMessaging::{DispatchMessageW, GetMessageW, MSG},
        },
    };

    pub fn main() -> windows::core::Result<()> {
        let bit_rate = 12_000_000;
        let frame_rate = 60;

        unsafe {
            RoInitialize(RO_INIT_MULTITHREADED).unwrap();
        }
        unsafe { MFStartup(MF_VERSION, MFSTARTUP_FULL).unwrap() }

        let display = Display::primary();
        let display = display.raw_handle();

        let input_resolution = display
            .physical_size()
            .map(|d| SizeInt32 {
                Width: d.width() as i32,
                Height: d.height() as i32,
            })
            .unwrap();
        let output_resolution = input_resolution;

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

        let encoder_device = VideoEncoderDevice::enumerate().unwrap().swap_remove(0);

        let transform = encoder_device.create_transform().unwrap();

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
        unsafe {
            media_device_manager.ResetDevice(capturer.d3d_device(), device_manager_reset_token)?
        };

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
            return Err(windows::core::Error::new(
                MF_E_TRANSFORM_TYPE_NOT_SET,
                "No suitable input type found! Try a different set of encoding settings.",
            ));
        }

        let (frame_tx, frame_rx) = std::sync::mpsc::channel();

        let mut first_timestamp = None;

        capturer
            .start(
                move |frame| {
                    dbg!(frame.inner().SystemRelativeTime());
                    let frame_time = frame.inner().SystemRelativeTime().unwrap();

                    let first_timestamp = first_timestamp.get_or_insert(frame_time);

                    let _ = frame_tx.send(VideoEncoderInputSample::new(
                        ::windows::Foundation::TimeSpan {
                            Duration: frame_time.Duration - first_timestamp.Duration,
                        },
                        frame.texture().clone(),
                    ));

                    Ok(())
                },
                || Ok(()),
            )
            .unwrap();

        struct Transformer {
            transform: IMFTransform,
            event_generator: IMFMediaEventGenerator,
        }

        unsafe impl Send for Transformer {}

        let transformer = Transformer {
            transform,
            event_generator,
        };

        std::thread::spawn(move || {
            unsafe {
                MFStartup(MF_VERSION, MFSTARTUP_FULL)?;

                let a = transformer;
                let Transformer {
                    transform,
                    event_generator,
                } = a;

                transform.ProcessMessage(MFT_MESSAGE_COMMAND_FLUSH, 0)?;
                transform.ProcessMessage(MFT_MESSAGE_NOTIFY_BEGIN_STREAMING, 0)?;
                transform.ProcessMessage(MFT_MESSAGE_NOTIFY_START_OF_STREAM, 0)?;

                let mut should_exit = false;
                while !should_exit {
                    let event =
                        event_generator.GetEvent(MEDIA_EVENT_GENERATOR_GET_EVENT_FLAGS(0))?;

                    let event_type = MF_EVENT_TYPE(event.GetType()? as i32);
                    match event_type {
                        MediaFoundation::METransformNeedInput => {
                            should_exit = true;

                            dbg!(event_type);
                            if let Ok(sample) = frame_rx.recv() {
                                dbg!(sample.timestamp);
                                let input_buffer = unsafe {
                                    MFCreateDXGISurfaceBuffer(
                                        &ID3D11Texture2D::IID,
                                        &sample.texture,
                                        0,
                                        false,
                                    )?
                                };
                                let mf_sample = unsafe { MFCreateSample()? };
                                unsafe {
                                    mf_sample.AddBuffer(&input_buffer)?;
                                    mf_sample.SetSampleTime(sample.timestamp.Duration)?;
                                    transform.ProcessInput(input_stream_id, &mf_sample, 0)?;
                                };
                                should_exit = false;
                            }
                        }
                        MediaFoundation::METransformHaveOutput => {
                            let mut status = 0;
                            let output_buffer = MFT_OUTPUT_DATA_BUFFER {
                                dwStreamID: output_stream_id,
                                ..Default::default()
                            };

                            let sample = unsafe {
                                let mut output_buffers = [output_buffer];
                                transform.ProcessOutput(0, &mut output_buffers, &mut status)?;
                                output_buffers[0].pSample.as_ref().unwrap().clone()
                            };

                            dbg!(sample.GetBufferCount()?);

                            // let output_sample = VideoEncoderOutputSample { sample };
                            // self.sample_rendered_callback.as_mut().unwrap()(output_sample)?;
                        }
                        _ => {
                            panic!("Unknown media event type: {}", event_type.0);
                        }
                    }
                }

                transform.ProcessMessage(MFT_MESSAGE_NOTIFY_END_OF_STREAM, 0)?;
                transform.ProcessMessage(MFT_MESSAGE_NOTIFY_END_STREAMING, 0)?;
                transform.ProcessMessage(MFT_MESSAGE_COMMAND_FLUSH, 0)?;
            }

            Ok::<(), windows::core::Error>(())
        });

        // std::thread::spawn(move || {
        unsafe {
            let mut message = MSG::default();
            while GetMessageW(&mut message, None, 0, 0).into() {
                // if message.message == WM_HOTKEY && hot_key_callback()? {
                //     break;
                // }
                DispatchMessageW(&message);
            }
        }
        // });

        std::thread::sleep(Duration::from_secs(3));

        capturer.stop().unwrap();

        std::thread::sleep(Duration::from_secs(3));

        Ok(())
    }

    #[derive(Clone)]
    pub struct VideoEncoderDevice {
        source: IMFActivate,
        display_name: String,
    }

    impl VideoEncoderDevice {
        pub fn enumerate() -> ::windows::core::Result<Vec<VideoEncoderDevice>> {
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

        pub fn create_transform(&self) -> ::windows::core::Result<IMFTransform> {
            unsafe { self.source.ActivateObject() }
        }
    }

    pub fn enumerate_mfts(
        category: &GUID,
        flags: MFT_ENUM_FLAG,
        input_type: Option<&MFT_REGISTER_TYPE_INFO>,
        output_type: Option<&MFT_REGISTER_TYPE_INFO>,
    ) -> ::windows::core::Result<Vec<IMFActivate>> {
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
    ) -> ::windows::core::Result<Option<String>> {
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

    pub struct VideoEncoderInputSample {
        timestamp: TimeSpan,
        texture: ID3D11Texture2D,
    }

    impl VideoEncoderInputSample {
        pub fn new(timestamp: TimeSpan, texture: ID3D11Texture2D) -> Self {
            Self { timestamp, texture }
        }
    }

    fn pack_2_u32_as_u64(high: u32, low: u32) -> u64 {
        ((high as u64) << 32) | low as u64
    }

    #[allow(non_snake_case)]
    unsafe fn MFSetAttribute2UINT32asUINT64(
        attributes: &IMFAttributes,
        key: &GUID,
        high: u32,
        low: u32,
    ) -> windows::core::Result<()> {
        unsafe { attributes.SetUINT64(key, pack_2_u32_as_u64(high, low)) }
    }

    #[allow(non_snake_case)]
    pub unsafe fn MFSetAttributeSize(
        attributes: &IMFAttributes,
        key: &GUID,
        width: u32,
        height: u32,
    ) -> windows::core::Result<()> {
        unsafe { MFSetAttribute2UINT32asUINT64(attributes, key, width, height) }
    }

    #[allow(non_snake_case)]
    pub unsafe fn MFSetAttributeRatio(
        attributes: &IMFAttributes,
        key: &GUID,
        numerator: u32,
        denominator: u32,
    ) -> windows::core::Result<()> {
        unsafe { MFSetAttribute2UINT32asUINT64(attributes, key, numerator, denominator) }
    }
}
