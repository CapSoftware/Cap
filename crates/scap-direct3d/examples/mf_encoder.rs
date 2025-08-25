fn main() {
    #[cfg(windows)]
    windows::main();
}

#[cfg(windows)]
mod windows {
    use cap_displays::*;
    use scap_direct3d::{Capturer, PixelFormat, Settings};
    use std::sync::mpsc;
    use std::thread;
    use std::time::{Duration, Instant};
    use windows::Win32::Graphics::Direct3D11::*;
    use windows::Win32::Graphics::Dxgi::*;
    use windows::{
        Win32::{Foundation::*, Media::MediaFoundation::*, System::Com::*},
        core::*,
    };

    #[derive(Debug)]
    enum EncoderMessage {
        Frame {
            texture: ID3D11Texture2D,
            timestamp: u64,
        },
        Stop,
    }

    pub fn main() {
        unsafe {
            CoInitializeEx(None, COINIT_APARTMENTTHREADED).unwrap();
            MFStartup(MF_VERSION, MFSTARTUP_NOSOCKET).unwrap();
        }

        let display = Display::primary();
        let display = display.raw_handle();

        let mut capturer = Capturer::new(
            display.try_as_capture_item().unwrap(),
            Settings {
                is_border_required: Some(false),
                is_cursor_capture_enabled: Some(true),
                pixel_format: PixelFormat::R8G8B8A8Unorm,
                ..Default::default()
            },
        )
        .unwrap();

        let (tx, rx) = mpsc::channel::<EncoderMessage>();
        let mut encoder_thread_handle = None;
        let start_time = Instant::now();
        let mut frame_count = 0u64;

        let mut rx = Some(rx);

        capturer
            .start(
                {
                    let tx = tx.clone();
                    move |frame| {
                        // Start encoder thread on first frame
                        if encoder_thread_handle.is_none()
                            && let Some(rx) = rx.take()
                        {
                            let thread_rx = rx;
                            let width = frame.width();
                            let height = frame.height();
                            let d3d_device = frame.d3d_device().clone();
                            let d3d_context = frame.d3d_context().clone();

                            encoder_thread_handle = Some(thread::spawn(move || {
                                encoder_thread_main(
                                    width,
                                    height,
                                    d3d_device,
                                    d3d_context,
                                    thread_rx,
                                )
                            }));
                        }

                        let timestamp = frame_count * 10_000_000 / 30; // 100ns units

                        // Clone the texture to send it to the encoder thread
                        let texture = frame.texture().clone();

                        // Send frame to encoder thread
                        let _ = tx
                            .send(EncoderMessage::Frame { texture, timestamp })
                            .map_err(|e| format!("Failed to send frame to encoder: {}", e));

                        frame_count += 1;
                        Ok(())
                    }
                },
                || Ok(()),
            )
            .unwrap();

        std::thread::sleep(Duration::from_secs(10));

        capturer.stop().unwrap();

        // Signal encoder thread to stop
        tx.send(EncoderMessage::Stop).unwrap();
        drop(tx); // Close the channel

        // Wait for encoder thread to finish
        // if let Some(handle) = encoder_thread_handle {
        //     handle.join().expect("Encoder thread panicked");
        // }

        println!(
            "Encoded {} frames in {:?} using hardware encoding",
            frame_count,
            start_time.elapsed()
        );

        unsafe {
            MFShutdown().unwrap();
            CoUninitialize();
        }
    }

    fn encoder_thread_main(
        width: u32,
        height: u32,
        d3d_device: ID3D11Device,
        d3d_context: ID3D11DeviceContext,
        rx: mpsc::Receiver<EncoderMessage>,
    ) {
        // Initialize COM for this thread
        unsafe {
            CoInitializeEx(None, COINIT_APARTMENTTHREADED).unwrap();
        }

        let mut encoder = MediaFoundationEncoder::new(width, height, 30, &d3d_device, &d3d_context)
            .expect("Failed to create encoder");

        // Process messages from the capturer
        while let Ok(message) = rx.recv() {
            match message {
                EncoderMessage::Frame { texture, timestamp } => {
                    if let Err(e) = encoder.encode_frame_from_texture(&texture, timestamp) {
                        eprintln!("Failed to encode frame: {}", e);
                    }
                }
                EncoderMessage::Stop => {
                    break;
                }
            }
        }

        // Finalize the encoder
        if let Err(e) = encoder.finalize() {
            eprintln!("Failed to finalize encoder: {}", e);
        }

        unsafe {
            CoUninitialize();
        }
    }

    struct MediaFoundationEncoder {
        sink_writer: IMFSinkWriter,
        stream_index: u32,
        width: u32,
        height: u32,
        d3d_device: ID3D11Device,
        dxgi_device_manager: IMFDXGIDeviceManager,
    }

    impl MediaFoundationEncoder {
        pub fn new(
            width: u32,
            height: u32,
            fps: u32,
            d3d_device: &ID3D11Device,
            _d3d_context: &ID3D11DeviceContext,
        ) -> windows::core::Result<Self> {
            unsafe {
                // Create DXGI Device Manager for hardware encoding
                let mut reset_token = 0u32;
                let mut dxgi_device_manager: Option<IMFDXGIDeviceManager> = None;
                MFCreateDXGIDeviceManager(&mut reset_token, &mut dxgi_device_manager)?;
                let dxgi_device_manager = dxgi_device_manager.unwrap();

                // Reset device manager with our D3D11 device
                dxgi_device_manager.ResetDevice(d3d_device, reset_token)?;

                // Create sink writer attributes for hardware encoding
                let mut attributes: Option<IMFAttributes> = None;
                MFCreateAttributes(&mut attributes, 10)?;
                let attributes = attributes.unwrap();

                // Enable hardware transforms (GPU encoding)
                attributes.SetUINT32(&MF_READWRITE_ENABLE_HARDWARE_TRANSFORMS, 1)?;
                attributes.SetUINT32(&MF_SINK_WRITER_DISABLE_THROTTLING, 1)?;
                attributes.SetUnknown(&MF_SINK_WRITER_D3D_MANAGER, &dxgi_device_manager)?;

                // Create sink writer
                let output_url = w!("output.mp4");
                let sink_writer = MFCreateSinkWriterFromURL(output_url, None, Some(&attributes))?;

                // Create output media type for H.264 with hardware encoding
                let output_type = MFCreateMediaType()?;

                output_type.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video)?;
                output_type.SetGUID(&MF_MT_SUBTYPE, &MFVideoFormat_H264)?;

                // Set high bitrate for quality
                output_type.SetUINT32(&MF_MT_AVG_BITRATE, width * height * 4)?; // 4 Mbps
                output_type
                    .SetUINT32(&MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive.0 as u32)?;

                // Set frame size
                let frame_size = ((width as u64) << 32) | (height as u64);
                output_type.SetUINT64(&MF_MT_FRAME_SIZE, frame_size)?;

                // Set frame rate
                let frame_rate = ((fps as u64) << 32) | 1u64;
                output_type.SetUINT64(&MF_MT_FRAME_RATE, frame_rate)?;

                // Set pixel aspect ratio
                let pixel_aspect_ratio = (1u64 << 32) | 1u64;
                output_type.SetUINT64(&MF_MT_PIXEL_ASPECT_RATIO, pixel_aspect_ratio)?;

                // Create input media type - use NV12 for hardware encoding efficiency
                let input_type = MFCreateMediaType()?;

                input_type.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video)?;
                input_type.SetGUID(&MF_MT_SUBTYPE, &MFVideoFormat_NV12)?; // NV12 is preferred for hardware encoding
                input_type
                    .SetUINT32(&MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive.0 as u32)?;
                input_type.SetUINT64(&MF_MT_FRAME_SIZE, frame_size)?;
                input_type.SetUINT64(&MF_MT_FRAME_RATE, frame_rate)?;
                input_type.SetUINT64(&MF_MT_PIXEL_ASPECT_RATIO, pixel_aspect_ratio)?;

                // Add stream
                let mut stream_index = 0u32;
                let stream_index = sink_writer.AddStream(&output_type)?;
                sink_writer.SetInputMediaType(stream_index, &input_type, None)?;

                // Start writing
                sink_writer.BeginWriting()?;

                Ok(Self {
                    sink_writer,
                    stream_index,
                    width,
                    height,
                    d3d_device: d3d_device.clone(),
                    dxgi_device_manager,
                })
            }
        }

        pub fn encode_frame_from_texture(
            &mut self,
            texture: &ID3D11Texture2D,
            timestamp: u64,
        ) -> windows::core::Result<()> {
            unsafe {
                // Get DXGI surface from texture
                let dxgi_surface: IDXGISurface = texture.cast()?;

                // Create DXGI buffer directly from surface
                let dxgi_buffer = MFCreateDXGISurfaceBuffer(
                    &ID3D11Texture2D::IID,
                    &dxgi_surface,
                    0,     // subresource index
                    false, // bottom up flag
                )?;

                // Create sample
                let sample = MFCreateSample()?;

                sample.AddBuffer(&dxgi_buffer)?;
                sample.SetSampleTime(timestamp as i64)?;

                // Calculate frame duration (100ns units)
                let frame_duration = 10_000_000 / 30; // 30 fps
                sample.SetSampleDuration(frame_duration)?;

                // Write sample - this will use hardware encoding
                self.sink_writer.WriteSample(self.stream_index, &sample)?;

                dbg!(timestamp);
                Ok(())
            }
        }

        pub fn finalize(self) -> windows::core::Result<()> {
            unsafe {
                self.sink_writer.Finalize()?;
                Ok(())
            }
        }
    }

    // Ensure we can access the D3D device from Frame
    trait FrameHardwareAccess {
        fn d3d_device(&self) -> &ID3D11Device;
        fn d3d_context(&self) -> &ID3D11DeviceContext;
    }

    impl FrameHardwareAccess for scap_direct3d::Frame<'_> {
        fn d3d_device(&self) -> &ID3D11Device {
            // Access the private field through the public accessor we added
            self.d3d_device()
        }

        fn d3d_context(&self) -> &ID3D11DeviceContext {
            // Access the private field through the public accessor we added
            self.d3d_context()
        }
    }
}
