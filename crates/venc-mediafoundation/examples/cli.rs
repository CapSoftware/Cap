use crate::{args::Args, hotkey::HotKey};
use cap_venc_mediafoundation::{
    d3d::create_d3d_device,
    displays::get_display_handle_from_index,
    media::MF_VERSION,
    resolution::Resolution,
    video::{
        SampleWriter, VideoEncoder, VideoEncoderInputSample, mf::encoder_device::VideoEncoderDevice,
    },
};
use clap::Parser;
use scap_targets::Display;
use std::{path::Path, sync::Arc, time::Duration};
use windows::{
    Foundation::{Metadata::ApiInformation, TimeSpan},
    Graphics::{
        Capture::{
            GraphicsCaptureAccess, GraphicsCaptureAccessKind, GraphicsCaptureItem,
            GraphicsCaptureSession,
        },
        SizeInt32,
    },
    Storage::{
        CreationCollisionOption, FileAccessMode, StorageFolder, Streams::IRandomAccessStream,
    },
    Win32::{
        Foundation::MAX_PATH,
        Graphics::Direct3D11::ID3D11Device,
        Media::MediaFoundation::{self, MFSTARTUP_FULL, MFStartup},
        Storage::FileSystem::GetFullPathNameW,
        System::{
            Diagnostics::Debug::{DebugBreak, IsDebuggerPresent},
            Threading::GetCurrentProcessId,
            WinRT::{RO_INIT_MULTITHREADED, RoInitialize},
        },
        UI::{
            Input::KeyboardAndMouse::{MOD_CONTROL, MOD_SHIFT},
            WindowsAndMessaging::{DispatchMessageW, GetMessageW, MSG, WM_HOTKEY},
        },
    },
    core::{HSTRING, Result, RuntimeName, h},
};

#[allow(clippy::too_many_arguments)]
fn run(
    display_index: usize,
    output_path: &str,
    bit_rate: u32,
    frame_rate: u32,
    resolution: Resolution,
    verbose: bool,
    wait_for_debugger: bool,
) -> Result<()> {
    unsafe {
        RoInitialize(RO_INIT_MULTITHREADED)?;
    }
    unsafe { MFStartup(MF_VERSION, MFSTARTUP_FULL)? }

    if wait_for_debugger {
        let pid = unsafe { GetCurrentProcessId() };
        println!("Waiting for a debugger to attach (PID: {})...", pid);
        loop {
            if unsafe { IsDebuggerPresent().into() } {
                break;
            }
            std::thread::sleep(Duration::from_secs(1));
        }
        unsafe {
            DebugBreak();
        }
    }

    // Check to make sure Windows.Graphics.Capture is available
    if !required_capture_features_supported()? {
        exit_with_error(
            "The required screen capture features are not supported on this device for this release of Windows!\nPlease update your operating system (minimum: Windows 10 Version 1903, Build 18362).",
        );
    }

    if verbose {
        println!(
            "Using index \"{}\" and path \"{}\".",
            display_index, output_path
        );
    }

    let item = Display::primary()
        .raw_handle()
        .try_as_capture_item()
        .unwrap();

    // Resolve encoding settings
    let resolution = if let Some(resolution) = resolution.get_size() {
        resolution
    } else {
        item.Size()?
    };
    let bit_rate = bit_rate * 1000000;

    let encoder_device = VideoEncoderDevice::enumerate().unwrap().swap_remove(0);

    // Start the recording
    {
        let d3d_device = create_d3d_device()?;

        let (frame_tx, frame_rx) = std::sync::mpsc::channel();

        let mut first_time = None;
        let mut capturer = scap_direct3d::Capturer::new(
            item,
            scap_direct3d::Settings {
                is_border_required: Some(false),
                ..Default::default()
            },
            {
                let frame_tx = frame_tx.clone();
                move |frame| {
                    let frame_time = frame.inner().SystemRelativeTime()?;

                    let first_time = first_time.get_or_insert(frame_time);
                    let timestamp = TimeSpan {
                        Duration: frame_time.Duration - first_time.Duration,
                    };

                    let _ = frame_tx.send(Some(VideoEncoderInputSample::new(
                        timestamp,
                        frame.texture().clone(),
                    )));

                    Ok(())
                }
            },
            move || {
                let _ = frame_tx.send(None);

                Ok(())
            },
            Some(d3d_device.clone()),
        )
        .unwrap();

        let mut video_encoder = VideoEncoder::new(
            &encoder_device,
            d3d_device.clone(),
            capturer.settings().pixel_format.as_dxgi(),
            resolution,
            resolution,
            bit_rate,
            frame_rate,
        )
        .unwrap();

        let output_path = std::env::current_dir().unwrap().join(output_path);

        let sample_writer = Arc::new(
            SampleWriter::new(output_path.as_path(), &video_encoder.output_type()).unwrap(),
        );

        capturer.start()?;
        sample_writer.start()?;

        std::thread::spawn({
            let sample_writer = sample_writer.clone();
            move || {
                unsafe { MFStartup(MF_VERSION, MFSTARTUP_FULL) }.unwrap();

                let mut inner = video_encoder.inner.take().unwrap();

                inner.start().unwrap();

                while let Ok(e) = inner.get_event() {
                    match e {
                        MediaFoundation::METransformNeedInput => {
                            let Some(frame) = frame_rx.recv().unwrap() else {
                                break;
                            };

                            if inner.handle_needs_input(frame).is_err() {
                                break;
                            }
                        }
                        MediaFoundation::METransformHaveOutput => {
                            let output_sample = inner.handle_has_output().unwrap();
                            sample_writer.write(&output_sample).unwrap();
                        }
                        _ => {}
                    }
                }

                inner.finish().unwrap();
            }
        });

        pause();

        capturer.stop().unwrap();
        sample_writer.stop()?;
    }

    Ok(())
}

fn main() {
    // Handle /?
    let args: Vec<_> = std::env::args().collect();
    if args.contains(&"/?".to_owned()) || args.contains(&"-?".to_owned()) {
        Args::parse_from(["displayrecorder.exe", "--help"]);
        std::process::exit(0);
    }

    let args = Args::parse();

    if let Some(command) = args.command {
        match command {
            args::Commands::EnumEncoders => enum_encoders().unwrap(),
        }
        return;
    }

    let monitor_index: usize = args.display;
    let output_path = args.output_file.as_str();
    let verbose = args.verbose;
    let wait_for_debugger = args.wait_for_debugger;
    let bit_rate: u32 = args.bit_rate;
    let frame_rate: u32 = args.frame_rate;
    let resolution: Resolution = args.resolution;

    // Validate some of the params
    if !validate_path(output_path) {
        exit_with_error("Invalid path specified!");
    }

    let result = run(
        monitor_index,
        output_path,
        bit_rate,
        frame_rate,
        resolution,
        verbose | wait_for_debugger,
        wait_for_debugger,
    );

    // We do this for nicer HRESULT printing when errors occur.
    if let Err(error) = result {
        error.code().unwrap();
    }
}

fn pause() {
    println!("Press ENTER to stop recording...");
    std::io::Read::read(&mut std::io::stdin(), &mut [0]).unwrap();
}

fn enum_encoders() -> Result<()> {
    let encoder_devices = VideoEncoderDevice::enumerate()?;
    if encoder_devices.is_empty() {
        exit_with_error("No hardware H264 encoders found!");
    }
    println!("Encoders ({}):", encoder_devices.len());
    for (i, encoder_device) in encoder_devices.iter().enumerate() {
        println!("  {} - {}", i, encoder_device.display_name());
    }
    Ok(())
}

fn validate_path<P: AsRef<Path>>(path: P) -> bool {
    let path = path.as_ref();
    let mut valid = true;
    if let Some(extension) = path.extension() {
        if extension != "mp4" {
            valid = false;
        }
    } else {
        valid = false;
    }
    valid
}

fn exit_with_error(message: &str) -> ! {
    println!("{}", message);
    std::process::exit(1);
}

fn win32_programmatic_capture_supported() -> Result<bool> {
    ApiInformation::IsApiContractPresentByMajor(
        &HSTRING::from("Windows.Foundation.UniversalApiContract"),
        8,
    )
}

fn required_capture_features_supported() -> Result<bool> {
    let result = ApiInformation::IsTypePresent(&HSTRING::from(GraphicsCaptureSession::NAME))? && // Windows.Graphics.Capture is present
    GraphicsCaptureSession::IsSupported()? && // The CaptureService is available
    win32_programmatic_capture_supported()?;
    Ok(result)
}

mod args {
    use clap::{Parser, Subcommand};

    use cap_venc_mediafoundation::resolution::Resolution;

    #[derive(Parser, Debug)]
    #[clap(author, version, about, long_about = None)]
    pub struct Args {
        /// The index of the display you'd like to record.
        #[clap(short, long, default_value_t = 0)]
        pub display: usize,

        /// The bit rate you would like to encode at (in Mbps).
        #[clap(short, long, default_value_t = 18)]
        pub bit_rate: u32,

        /// The frame rate you would like to encode at.
        #[clap(short, long, default_value_t = 60)]
        pub frame_rate: u32,

        /// The resolution you would like to encode at: native, 720p, 1080p, 2160p, or 4320p.
        #[clap(short, long, default_value_t = Resolution::Native)]
        pub resolution: Resolution,

        /// The index of the encoder you'd like to use to record (use enum-encoders command for a list of encoders and their indices).
        #[clap(short, long, default_value_t = 0)]
        pub encoder: usize,

        /// Disables the yellow capture border (only available on Windows 11).
        #[clap(long)]
        pub borderless: bool,

        /// Enables verbose (debug) output.
        #[clap(short, long)]
        pub verbose: bool,

        /// The program will wait for a debugger to attach before starting.
        #[clap(long)]
        pub wait_for_debugger: bool,

        /// Recording immediately starts. End the recording through console input.
        #[clap(long)]
        pub console_mode: bool,

        /// The output file that will contain the recording.
        #[clap(default_value = "recording.mp4")]
        pub output_file: String,

        /// Subcommands to execute.
        #[clap(subcommand)]
        pub command: Option<Commands>,
    }

    #[derive(Subcommand, Debug)]
    #[clap(args_conflicts_with_subcommands = true)]
    pub enum Commands {
        /// Lists the available hardware H264 encoders.
        EnumEncoders,
    }
}

mod hotkey {
    use std::sync::atomic::{AtomicI32, Ordering};
    use windows::{
        Win32::UI::Input::KeyboardAndMouse::{HOT_KEY_MODIFIERS, RegisterHotKey, UnregisterHotKey},
        core::Result,
    };

    static HOT_KEY_ID: AtomicI32 = AtomicI32::new(0);

    pub struct HotKey {
        id: i32,
    }

    impl HotKey {
        pub fn new(modifiers: HOT_KEY_MODIFIERS, key: u32) -> Result<Self> {
            let id = HOT_KEY_ID.fetch_add(1, Ordering::SeqCst) + 1;
            unsafe {
                RegisterHotKey(None, id, modifiers, key)?;
            }
            Ok(Self { id })
        }
    }

    impl Drop for HotKey {
        fn drop(&mut self) {
            unsafe { UnregisterHotKey(None, self.id).ok().unwrap() }
        }
    }
}

#[cfg(test)]
mod tests {
    use crate::validate_path;

    #[test]
    fn path_parsing_test() {
        assert!(validate_path("something.mp4"));
        assert!(validate_path("somedir/something.mp4"));
        assert!(validate_path("somedir\\something.mp4"));
        assert!(validate_path("../something.mp4"));

        assert!(!validate_path("."));
        assert!(!validate_path("*"));
        assert!(!validate_path("something"));
        assert!(!validate_path(".mp4"));
        assert!(!validate_path("mp4"));
        assert!(!validate_path("something.avi"));
    }
}
