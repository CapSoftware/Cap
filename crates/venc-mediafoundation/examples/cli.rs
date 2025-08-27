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
    use ::windows::Win32::UI::HiDpi::{PROCESS_PER_MONITOR_DPI_AWARE, SetProcessDpiAwareness};
    use ::windows::Win32::UI::WindowsAndMessaging::{
        DispatchMessageW, GetMessageW, MSG, WM_HOTKEY,
    };
    use ::windows::{
        Storage::{CreationCollisionOption, StorageFolder},
        Win32::{Foundation::MAX_PATH, Storage::FileSystem::GetFullPathNameW},
        core::HSTRING,
    };
    use cap_venc_mediafoundation::*;
    use scap_direct3d::{Capturer, PixelFormat, Settings};
    use scap_targets::*;
    use std::{
        path::Path,
        sync::Arc,
        time::{Duration, Instant},
    };

    use super::*;

    pub fn main() {
        // unsafe { SetProcessDpiAwareness(PROCESS_PER_MONITOR_DPI_AWARE).unwrap() };
        unsafe {
            RoInitialize(RO_INIT_MULTITHREADED).unwrap();
        }
        unsafe { MFStartup(MF_VERSION, MFSTARTUP_FULL).unwrap() }

        let display = Display::primary();
        let display = display.raw_handle();

        let display_size = display.physical_size().unwrap();

        let (frame_tx, frame_rx) = std::sync::mpsc::channel();

        let mut capturer = Capturer::new(
            display.try_as_capture_item().unwrap(),
            Settings {
                is_border_required: Some(false),
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
                Width: display_size.width() as i32,
                Height: display_size.height() as i32,
            },
            SizeInt32 {
                Width: display_size.width() as i32,
                Height: display_size.height() as i32,
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

        video_encoder.set_sample_requested_callback(move || {
            println!("bruh");
            let frame = frame_rx.recv().ok();
            dbg!(frame.is_some());
            Ok(frame)
        });

        let sample_writer = Arc::new(SampleWriter::new(stream, &output_type).unwrap());
        video_encoder.set_sample_rendered_callback({
            let sample_writer = sample_writer.clone();
            move |sample| sample_writer.write(sample.sample())
        });

        println!("starting");

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

        println!("started");

        unsafe {
            let mut message = MSG::default();
            while GetMessageW(&mut message, None, 0, 0).into() {
                // if message.message == WM_HOTKEY && hot_key_callback()? {
                //     break;
                // }
                DispatchMessageW(&message);
            }
        }
        std::thread::sleep(Duration::from_secs(10));

        println!("stopping");

        video_encoder.stop().unwrap();
        sample_writer.stop().unwrap();
        capturer.stop().unwrap();

        println!("stopped");

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
