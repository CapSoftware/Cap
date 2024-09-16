use nokhwa::utils::CameraFormat;
use serde::Serialize;
use specta::Type;
use std::{fs::File, io::Write, path::PathBuf, sync::atomic::Ordering, time::Instant};
use tokio::sync::{oneshot, watch};

use tauri::{AppHandle, Manager, WebviewUrl};

use cap_ffmpeg::NamedPipeCapture;

pub const WINDOW_LABEL: &str = "camera";
const CAMERA_ROUTE: &str = "/camera";
const WINDOW_SIZE: f64 = 230.0 * 2.0;

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
        .title("Cap")
        .maximized(false)
        .resizable(false)
        .shadow(false)
        .fullscreen(false)
        .decorations(false)
        .always_on_top(true)
        .content_protected(true)
        .visible_on_all_workspaces(true)
        .min_inner_size(WINDOW_SIZE, WINDOW_SIZE * 2.0)
        .inner_size(WINDOW_SIZE, WINDOW_SIZE * 2.0)
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
pub fn list_cameras() -> Vec<String> {
    nokhwa::query(nokhwa::utils::ApiBackend::Auto)
        .unwrap()
        .into_iter()
        .map(|i| i.human_name().to_string())
        .collect()
}

pub fn find_camera_by_label(label: &str) -> Option<nokhwa::utils::CameraInfo> {
    nokhwa::query(nokhwa::utils::ApiBackend::Auto)
        .unwrap()
        .into_iter()
        .find(|c| &c.human_name() == label)
}

#[derive(Serialize, Type)]
pub struct CameraInfo {
    pub human_name: String,
    pub description: String,
}

pub async fn start_capturing(
    pipe_path: PathBuf,
    camera_info: nokhwa::utils::CameraInfo,
    mut start_writing_rx: watch::Receiver<bool>,
) -> (CameraFormat, NamedPipeCapture, Instant) {
    let (video_info_tx, video_info_rx) = oneshot::channel();

    let (capture, is_stopped, is_paused) = NamedPipeCapture::new(&pipe_path);

    let (start_tx, start_rx) = oneshot::channel();
    let (frame_tx, mut frame_rx) = watch::channel(None);

    std::thread::spawn(move || {
        use nokhwa::{pixel_format::*, utils::*, *};

        nokhwa::nokhwa_initialize(move |granted| {
            if granted {
                println!("Camera access granted");
            } else {
                println!("Camera access denied");
            }
        });

        let format =
            RequestedFormat::new::<RgbFormat>(RequestedFormatType::AbsoluteHighestFrameRate);
        let mut camera = Camera::new(camera_info.index().clone(), format).unwrap();

        video_info_tx.send(camera.camera_format()).ok();

        camera.open_stream().unwrap();

        let mut start_tx = Some(start_tx);

        loop {
            if is_stopped.load(Ordering::Relaxed) {
                println!("Stopping receiving camera frames");
                return;
            }
            let frame = camera.frame().unwrap();

            if let Some(start_tx) = start_tx.take() {
                start_tx.send(Instant::now()).unwrap();
            }

            if *start_writing_rx.borrow_and_update() {
                frame_tx.send(Some(frame)).ok();
            }
        }
    });

    tokio::spawn(async move {
        frame_rx.borrow_and_update();

        let mut file = File::create(&pipe_path).unwrap();

        loop {
            frame_rx.changed().await.unwrap();

            if let Some(frame) = &*frame_rx.borrow() {
                file.write_all(frame.buffer()).ok();
            }
        }
    });

    (
        video_info_rx.await.unwrap(),
        capture,
        start_rx.await.unwrap(),
    )
}
