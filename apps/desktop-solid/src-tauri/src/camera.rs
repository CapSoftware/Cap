use nokhwa::utils::{CameraFormat, FrameFormat};
use serde::Serialize;
use specta::Type;
use std::{
    io::Write,
    path::{Path, PathBuf},
    sync::atomic::Ordering,
};
use tokio::sync::oneshot;

use tauri::{AppHandle, Manager, WebviewUrl};

use crate::ffmpeg::NamedPipeCapture;

pub const WINDOW_LABEL: &str = "camera";
const CAMERA_ROUTE: &str = "/camera";
const WINDOW_SIZE: f64 = 230.0;

#[tauri::command]
#[specta::specta]
pub fn create_camera_window(app: AppHandle) {
    if let Some(window) = app.get_webview_window(WINDOW_LABEL) {
        window.set_focus().ok();
    } else {
        let monitor = app.primary_monitor().unwrap().unwrap();

        let window = tauri::webview::WebviewWindow::builder(
            &app,
            WINDOW_LABEL,
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

pub async fn start_capturing(
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
            file.write_all(frame.buffer()).ok();
        }
    });

    (video_info_rx.await.unwrap(), capture)
}
