use nokhwa::utils::{CameraInfo, Resolution};
use std::{
    io::Write,
    path::{Path, PathBuf},
    process::{ChildStdin, Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Duration,
};
use tokio::{sync::oneshot, time::sleep};

use tauri::{AppHandle, Manager, WebviewUrl};

pub const CAMERA_WINDOW: &str = "camera";
const CAMERA_ROUTE: &str = "/camera";
const WINDOW_SIZE: f64 = 230.0;

#[tauri::command]
#[specta::specta]
pub fn create_camera_window(app: AppHandle) {
    if let Some(window) = app.get_webview_window(CAMERA_WINDOW) {
        window.set_focus().ok();
    } else {
        let monitor = app.primary_monitor().unwrap().unwrap();

        let window = tauri::webview::WebviewWindow::builder(
            &app,
            CAMERA_WINDOW,
            WebviewUrl::App(CAMERA_ROUTE.into()),
        )
        .title("Cap Camera")
        .maximized(false)
        .resizable(false)
        .fullscreen(false)
        .decorations(false)
        .always_on_top(true)
        .visible_on_all_workspaces(true)
        .inner_size(WINDOW_SIZE, WINDOW_SIZE)
        .position(
            100.0,
            (monitor.size().height as f64) / monitor.scale_factor() - WINDOW_SIZE - 100.0,
        )
        .build()
        .unwrap();

        #[cfg(target_os = "macos")]
        {
            use tauri_plugin_decorum::WebviewWindowExt;

            window.make_transparent().ok();
        }
    }
}

#[cfg(unix)]
pub fn create_named_pipe(path: &Path) -> Result<(), Box<dyn std::error::Error>> {
    use nix::sys::stat;
    use nix::unistd;
    unistd::mkfifo(path, stat::Mode::S_IRWXU)?;
    Ok(())
}

pub struct FfmpegRecording {
    folder_path: PathBuf,
    ffmpeg_stdin: ChildStdin,
    capture: NamedPipeCapture,
}

impl FfmpegRecording {
    pub fn stop(mut self) {
        self.ffmpeg_stdin.write_all(b"q").ok();
        self.capture.stop();
    }
}

pub async fn start_recording(folder_path: &Path, camera_info: CameraInfo) -> FfmpegRecording {
    std::fs::create_dir_all(folder_path).ok();
    let pipe_path = folder_path.join("output.pipe");
    std::fs::remove_file(&pipe_path).ok();

    let output_path = folder_path.join("output.mp4");
    std::fs::remove_file(&output_path).ok();

    println!("Beginning camera capture");

    let ((resolution, frame_rate), capture) = start_capturing(pipe_path.clone(), camera_info).await;

    println!("Received video info: {:?}", (resolution, frame_rate));

    let size = format!("{}x{}", resolution.width(), resolution.height());

    let mut cmd = Command::new("ffmpeg")
        .args(&["-f", "rawvideo", "-pix_fmt", "uyvy422"])
        .args(["-s", &size, "-r", &frame_rate.to_string()])
        .args(["-thread_queue_size", "4096", "-i"])
        .arg(pipe_path.to_str().unwrap())
        .args(["-f", "mp4"])
        .args(["-codec:v", "libx264", "-preset", "ultrafast"])
        .args(["-pix_fmt", "yuv420p", "-tune", "zerolatency"])
        .args(["-vsync", "1", "-force_key_frames", "expr:gte(t,n_forced*3)"])
        .args(["-movflags", "frag_keyframe+empty_moov"])
        .args([
            "-vf",
            &format!("fps={frame_rate},scale=in_range=full:out_range=limited"),
        ])
        .arg(output_path)
        .stdin(Stdio::piped())
        .spawn()
        .expect("Failed to execute command");

    FfmpegRecording {
        folder_path: folder_path.to_path_buf(),
        ffmpeg_stdin: cmd.stdin.take().unwrap(),
        capture,
    }
}

async fn start_capturing(
    pipe_path: PathBuf,
    camera_info: CameraInfo,
) -> ((Resolution, u32), NamedPipeCapture) {
    std::fs::remove_file(&pipe_path).ok();
    create_named_pipe(&pipe_path).unwrap();

    let stop = Arc::new(AtomicBool::new(false));
    let (video_info_tx, video_info_rx) = oneshot::channel();

    let capture = NamedPipeCapture {
        path: pipe_path.clone(),
        stop: stop.clone(),
    };

    std::thread::spawn(move || {
        use nokhwa::{pixel_format::*, utils::*, *};

        nokhwa::nokhwa_initialize(|granted| {
            if granted {
                println!("Camera access granted");
            } else {
                println!("Camera access denied");
            }
        });

        let format =
            RequestedFormat::new::<RgbFormat>(RequestedFormatType::AbsoluteHighestFrameRate);
        let mut camera = Camera::new(camera_info.index().clone(), format).unwrap();

        video_info_tx
            .send((camera.resolution(), camera.frame_rate()))
            .ok();

        camera.open_stream().unwrap();

        println!("Opening pipe");
        let mut file = std::fs::File::create(&pipe_path).unwrap();
        println!("Pipe opened");

        println!("Receiving frames");
        loop {
            if stop.load(Ordering::Relaxed) {
                println!("Stopping receiving frames");
                return;
            }
            file.write_all(camera.frame().unwrap().buffer()).ok();
        }
    });

    (video_info_rx.await.unwrap(), capture)
}

struct NamedPipeCapture {
    path: PathBuf,
    stop: Arc<AtomicBool>,
}

impl NamedPipeCapture {
    fn path(&self) -> &PathBuf {
        &self.path
    }

    fn stop(&self) {
        self.stop.store(true, Ordering::Relaxed);
    }
}
