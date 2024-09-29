use ffmpeg_next as ffmpeg;
use serde::Serialize;
use specta::Type;
use std::{path::PathBuf, time::Instant};
use tokio::sync::{oneshot, watch};

use tauri::{AppHandle, Manager, WebviewUrl};

use crate::{
    capture::CaptureController,
    encoder::{uyvy422_frame, H264Encoder},
};

pub const WINDOW_LABEL: &str = "camera";
const CAMERA_ROUTE: &str = "/camera";
const WINDOW_SIZE: f64 = 230.0 * 2.0;

#[tauri::command(async)]
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

#[tauri::command(async)]
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

// ffmpeg
//     .command
//     .args(["-f", "mp4", "-map", &format!("{}:v", ffmpeg_input.index)])
//     .args(["-codec:v", "libx264", "-preset", "ultrafast"])
//     .args(["-pix_fmt", "yuv420p", "-tune", "zerolatency"])
//     .args(["-vsync", "1", "-force_key_frames", "expr:gte(t,n_forced*3)"])
//     .args(["-movflags", "frag_keyframe+empty_moov"])
//     .args(["-g", &keyframe_interval_str])
//     .args(["-keyint_min", &keyframe_interval_str])
//     .args([
//         "-vf",
//         &format!(
//             "fps={},scale=in_range=full:out_range=limited",
//             ffmpeg_input.fps
//         ),
//     ])
//     .arg(&output_path);

pub async fn start_capturing(
    output_path: PathBuf,
    camera_info: nokhwa::utils::CameraInfo,
    mut start_writing_rx: watch::Receiver<bool>,
) -> CaptureController {
    let controller = CaptureController::new(output_path);

    let (start_tx, start_rx) = oneshot::channel();

    std::thread::spawn({
        let controller = controller.clone();
        move || {
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

            let format = camera.camera_format();

            let capture_format = ffmpeg::format::Pixel::UYVY422;
            let output_format = H264Encoder::output_format();

            let (width, height) = (format.resolution().width(), format.resolution().height());

            let mut encoder = H264Encoder::new(&controller.output_path, width, height, 30.0);

            let mut scaler =
                ffmpeg::software::converter((width, height), capture_format, output_format)
                    .unwrap();

            camera.open_stream().unwrap();

            let mut start_tx = Some(start_tx);

            loop {
                if controller.is_stopped() {
                    println!("Stopping receiving camera frames");
                    break;
                }

                let frame = camera.frame().unwrap();

                if controller.is_paused() {
                    continue;
                }

                if let Some(start_tx) = start_tx.take() {
                    start_tx.send(Instant::now()).unwrap();
                }

                if !*start_writing_rx.borrow_and_update() {
                    continue;
                }

                let yuyv422_frame = uyvy422_frame(frame.buffer(), width, height);

                let mut yuv_frame = ffmpeg::util::frame::Video::empty();
                scaler.run(&yuyv422_frame, &mut yuv_frame).unwrap();

                encoder.encode_frame(yuv_frame);
            }

            encoder.close();
        }
    });

    start_rx.await.unwrap(); // wait for first frame

    controller
}
