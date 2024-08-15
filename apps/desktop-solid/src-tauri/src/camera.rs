use nokhwa::utils::{CameraFormat, FrameFormat, Resolution};
use serde::Serialize;
use specta::Type;
use std::{
    io::Write,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};
use tokio::sync::oneshot;

use tauri::{AppHandle, Manager, WebviewUrl};

use crate::ffmpeg::{FFmpegRawVideoSource, NamedPipeCapture};

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

#[tauri::command]
#[specta::specta]
pub fn get_cameras() -> Vec<CameraInfo> {
    nokhwa::query(nokhwa::utils::ApiBackend::Auto)
        .unwrap()
        .into_iter()
        .map(|i| CameraInfo {
            human_name: i.human_name().to_string(),
            description: i.description().to_string(),
            misc: i.misc().to_string(),
            index: match i.index() {
                nokhwa::utils::CameraIndex::Index(i) => CameraIndex::Index(*i),
                nokhwa::utils::CameraIndex::String(s) => CameraIndex::String(s.to_string()),
            },
        })
        .collect()
}

#[derive(Serialize, Type)]
pub struct CameraInfo {
    pub human_name: String,
    pub description: String,
    pub misc: String,
    pub index: CameraIndex,
}

#[derive(Serialize, Type)]
pub enum CameraIndex {
    Index(u32),
    String(String),
}

impl From<CameraIndex> for nokhwa::utils::CameraIndex {
    fn from(value: CameraIndex) -> Self {
        match value {
            CameraIndex::Index(i) => nokhwa::utils::CameraIndex::Index(i),
            CameraIndex::String(s) => nokhwa::utils::CameraIndex::String(s),
        }
    }
}

pub async fn start_recording(
    output_folder: &Path,
    output_name: &str,
    camera_info: CameraInfo,
) -> FFmpegRawVideoSource {
    std::fs::create_dir_all(output_folder).ok();

    let pipe_path = output_folder.join(format!("{output_name}.pipe"));

    let output_path = output_folder.join(format!("{output_name}.mp4"));
    std::fs::remove_file(&output_path).ok();

    println!("Beginning camera recording");

    let (camera_format, capture) = start_capturing(pipe_path.clone(), camera_info).await;

    println!(
        "Received video info: {:?}",
        (camera_format.resolution(), camera_format.frame_rate())
    );

    FFmpegRawVideoSource {
        width: camera_format.resolution().width(),
        height: camera_format.resolution().height(),
        fps: camera_format.frame_rate(),
        input: pipe_path,
        output: output_path,
        pix_fmt: match camera_format.format() {
            FrameFormat::YUYV => "uyvy422",
            FrameFormat::RAWRGB => "rgb24",
            FrameFormat::NV12 => "nv12",
            _ => panic!("unimplemented"),
        },
        capture,
    }
}

async fn start_capturing(
    pipe_path: PathBuf,
    camera_info: CameraInfo,
) -> (CameraFormat, NamedPipeCapture) {
    let (video_info_tx, video_info_rx) = oneshot::channel();

    let (capture, is_stopped) = NamedPipeCapture::new(&pipe_path);

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
        let mut camera = Camera::new(camera_info.index.into(), format).unwrap();

        video_info_tx.send(camera.camera_format()).ok();

        camera.open_stream().unwrap();

        println!("Opening pipe");
        let mut file = std::fs::File::create(&pipe_path).unwrap();
        println!("Pipe opened");

        println!("Receiving frames");
        loop {
            if is_stopped.load(Ordering::Relaxed) {
                println!("Stopping receiving camera frames");
                return;
            }
            let frame = camera.frame().unwrap();
            dbg!(frame.source_frame_format());
            dbg!(frame.buffer().len());
            dbg!(frame.resolution());
            file.write_all(frame.buffer()).ok();
        }
    });

    (video_info_rx.await.unwrap(), capture)
}
