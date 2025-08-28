use crate::{args::Args, hotkey::HotKey};
use cap_venc_mediafoundation::{
    capture::create_capture_item_for_monitor,
    d3d::create_d3d_device,
    displays::get_display_handle_from_index,
    media::MF_VERSION,
    resolution::Resolution,
    video::{
        backend::EncoderBackend,
        encoding_session::{VideoEncoderSessionFactory, VideoEncodingSession},
        mf::{encoder_device::VideoEncoderDevice, encoding_session::MFVideoEncodingSessionFactory},
        wmt::encoding_session::WMTVideoEncodingSessionFactory,
    },
};
use clap::Parser;
use scap_targets::Display;
use std::{path::Path, time::Duration};
use windows::{
    Foundation::Metadata::ApiInformation,
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
        Media::MediaFoundation::{MFSTARTUP_FULL, MFStartup},
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
    encoder_index: usize,
    borderless: bool,
    verbose: bool,
    wait_for_debugger: bool,
    console_mode: bool,
    backend: EncoderBackend,
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

    let display_handle = get_display_handle_from_index(display_index)?
        .expect("The provided display index was out of bounds!");
    let item = create_capture_item_for_monitor(display_handle)?;

    // Get the display handle using the provided index
    // let display_handle = get_display_handle_from_index(display_index)?
    //     .expect("The provided display index was out of bounds!");
    // let item = create_capture_item_for_monitor(display_handle)?;

    // Resolve encoding settings
    let resolution = if let Some(resolution) = resolution.get_size() {
        resolution
    } else {
        item.Size()?
    };
    let bit_rate = bit_rate * 1000000;
    let session_factory = create_encoding_session_factory(backend, encoder_index, verbose)?;

    // Create our file
    let path = unsafe {
        let mut new_path = vec![0u16; MAX_PATH as usize];
        let length = GetFullPathNameW(&HSTRING::from(output_path), Some(&mut new_path), None);
        new_path.resize(length as usize, 0);
        String::from_utf16(&new_path).unwrap()
    };
    let path = Path::new(&path);
    let parent_folder_path = path.parent().unwrap();
    let parent_folder = StorageFolder::GetFolderFromPathAsync(&HSTRING::from(
        parent_folder_path.as_os_str().to_str().unwrap(),
    ))?
    .get()?;
    let file_name = path.file_name().unwrap();
    let file = parent_folder
        .CreateFileAsync(
            &HSTRING::from(file_name.to_str().unwrap()),
            CreationCollisionOption::ReplaceExisting,
        )?
        .get()?;

    // Start the recording
    {
        let stream = file.OpenAsync(FileAccessMode::ReadWrite)?.get()?;
        let d3d_device = create_d3d_device()?;
        let mut session = create_encoding_session(
            d3d_device,
            item,
            borderless,
            &session_factory,
            resolution,
            bit_rate,
            frame_rate,
            stream,
        )?;
        if !console_mode {
            let mut is_recording = false;
            pump_messages(|| -> Result<bool> {
                Ok(if !is_recording {
                    is_recording = true;
                    println!("Starting recording...");
                    session.start()?;
                    false
                } else {
                    true
                })
            })?;
            println!("Stopping recording...");
        } else {
            session.start()?;
            pause();
        }
        session.stop()?;
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
    let console_mode = args.console_mode;
    let bit_rate: u32 = args.bit_rate;
    let frame_rate: u32 = args.frame_rate;
    let resolution: Resolution = args.resolution;
    let encoder_index: usize = args.encoder;
    let backend: EncoderBackend = args.backend;

    let borderless = if args.borderless {
        // Make sure the machine we're running on supports borderless capture
        let borderless = ApiInformation::IsPropertyPresent(
            &HSTRING::from(GraphicsCaptureSession::NAME),
            h!("IsBorderRequired"),
        )
        .unwrap_or(false);
        if borderless {
            let _ =
                GraphicsCaptureAccess::RequestAccessAsync(GraphicsCaptureAccessKind::Borderless)
                    .unwrap()
                    .get()
                    .unwrap();
        } else {
            println!(
                "WARNING: Borderless capture is not supported on this build of Windows, ignoring..."
            );
        }
        borderless
    } else {
        false
    };

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
        encoder_index,
        borderless,
        verbose | wait_for_debugger,
        wait_for_debugger,
        console_mode,
        backend,
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

fn create_encoding_session_factory(
    backend: EncoderBackend,
    encoder_index: usize,
    verbose: bool,
) -> Result<Box<dyn VideoEncoderSessionFactory>> {
    Ok(match backend {
        EncoderBackend::MediaFoundation => {
            let encoder_devices = VideoEncoderDevice::enumerate()?;
            if encoder_devices.is_empty() {
                exit_with_error("No hardware H264 encoders found!");
            }
            if verbose {
                println!("Encoders ({}):", encoder_devices.len());
                for encoder_device in &encoder_devices {
                    println!("  {}", encoder_device.display_name());
                }
            }
            let encoder_device = if let Some(encoder_device) = encoder_devices.get(encoder_index) {
                encoder_device
            } else {
                exit_with_error("Encoder index is out of bounds!");
            };
            if verbose {
                println!("Using: {}", encoder_device.display_name());
            }
            Box::new(MFVideoEncodingSessionFactory::new(encoder_device.clone()))
        }
        EncoderBackend::WindowsMediaTranscoding => Box::new(WMTVideoEncodingSessionFactory::new()),
    })
}

fn create_encoding_session(
    d3d_device: ID3D11Device,
    item: GraphicsCaptureItem,
    borderless: bool,
    factory: &Box<dyn VideoEncoderSessionFactory>,
    resolution: SizeInt32,
    bit_rate: u32,
    frame_rate: u32,
    stream: IRandomAccessStream,
) -> Result<Box<dyn VideoEncodingSession>> {
    let result = factory.create_session(
        d3d_device, item, borderless, resolution, bit_rate, frame_rate, stream,
    );
    if result.is_err() {
        println!("Error during encoder setup, try another set of encoding settings.");
    }
    result
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

fn pump_messages<F: FnMut() -> Result<bool>>(mut hot_key_callback: F) -> Result<()> {
    let _hot_key = HotKey::new(MOD_SHIFT | MOD_CONTROL, 0x52 /* R */)?;
    println!("Press SHIFT+CTRL+R to start/stop the recording...");
    unsafe {
        let mut message = MSG::default();
        while GetMessageW(&mut message, None, 0, 0).into() {
            if message.message == WM_HOTKEY && hot_key_callback()? {
                break;
            }
            DispatchMessageW(&message);
        }
    }
    Ok(())
}

mod args {
    use clap::{Parser, Subcommand};

    use cap_venc_mediafoundation::{resolution::Resolution, video::backend::EncoderBackend};

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

        /// The backend to use for the video encoder.
        #[clap(long, default_value_t = EncoderBackend::MediaFoundation)]
        pub backend: EncoderBackend,

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
