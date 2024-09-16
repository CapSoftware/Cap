use std::{fs::File, io::Write, path::PathBuf, sync::atomic::Ordering, time::Instant};

use scap::{
    capturer::{Area, Capturer, Options, Point, Resolution, Size},
    frame::{Frame, FrameType},
    Target,
};
use serde::{Deserialize, Serialize};
use specta::Type;
use tokio::sync::{oneshot, watch};

use crate::macos;
use cap_ffmpeg::NamedPipeCapture;

#[derive(Type, Serialize, Deserialize, Debug, Clone)]
pub struct Bounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Type, Serialize)]
pub struct CaptureWindow {
    id: u32,
    name: String,
}

#[derive(specta::Type, Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase", tag = "type")]
pub enum CaptureTarget {
    Screen,
    Window { id: u32 },
}

#[tauri::command(async)]
#[specta::specta]
pub fn list_capture_windows() -> Vec<CaptureWindow> {
    if !scap::has_permission() {
        return vec![];
    }

    let targets = scap::get_all_targets();

    let windows = macos::get_on_screen_windows();

    targets
        .into_iter()
        .filter_map(|target| match target {
            Target::Window(scap_window)
                if windows
                    .iter()
                    .any(|window| window.window_number == scap_window.raw_handle) =>
            {
                Some(scap_window)
            }
            _ => None,
        })
        .map(|target| CaptureWindow {
            id: target.id,
            name: target.title,
        })
        .collect::<Vec<_>>()
}

pub const FPS: u32 = 30;

pub async fn start_capturing(
    pipe_path: PathBuf,
    capture_target: &CaptureTarget,
    start_writing_rx: watch::Receiver<bool>,
) -> ((u32, u32), NamedPipeCapture, Instant) {
    dbg!(capture_target);

    let targets = scap::get_all_targets();

    let mut capturer = {
        let crop_area = match capture_target {
            CaptureTarget::Window { id: window_number } => {
                get_window_bounds(*window_number).map(|bounds| Area {
                    size: Size {
                        width: bounds.width,
                        height: bounds.height,
                    },
                    origin: Point {
                        x: bounds.x,
                        y: bounds.y,
                    },
                })
            }
            _ => None,
        };

        let excluded_titles = [
            "Cap",
            "Cap Camera",
            "Cap Recordings",
            "Cap In Progress Recording",
        ];
        let excluded_targets: Vec<scap::Target> = targets
            .clone()
            .into_iter()
            .filter(|target| match target {
                Target::Window(scap_window)
                    if excluded_titles.contains(&scap_window.title.as_str()) =>
                {
                    true
                }
                _ => false,
            })
            .collect();

        let options = Options {
            fps: FPS,
            show_highlight: true,
            output_type: FrameType::BGRAFrame,
            output_resolution: Resolution::_2160p,
            crop_area,
            excluded_targets: Some(excluded_targets),
            ..Default::default()
        };

        Capturer::new(dbg!(options))
    };

    let [width, height] = capturer.get_output_frame_size();

    let (capture, is_stopped, is_paused) = NamedPipeCapture::new(&pipe_path);

    let (tx, rx) = oneshot::channel();

    let (frame_tx, mut frame_rx) = watch::channel(vec![]);

    std::thread::spawn(move || {
        capturer.start_capture();

        let mut start_time = Some(tx);
        loop {
            if is_stopped.load(Ordering::Relaxed) {
                println!("Stopping receiving capture frames");
                return;
            }

            if is_paused.load(Ordering::Relaxed) {
                std::thread::sleep(std::time::Duration::from_millis(100));
                continue;
            }

            let frame = capturer.get_next_frame();

            if let Some(tx) = start_time.take() {
                tx.send(Instant::now()).ok();
            }

            if !*start_writing_rx.borrow() {
                continue;
            }

            match frame {
                Ok(Frame::BGRA(frame)) => {
                    frame_tx.send(frame.data).ok();
                }
                _ => println!("Failed to get frame"),
            }
        }
    });

    tokio::spawn(async move {
        frame_rx.borrow_and_update();

        let mut file = File::create(&pipe_path).unwrap();

        loop {
            if frame_rx.changed().await.is_err() {
                println!("Closing display pipe writer");
                return;
            }

            let frame = frame_rx.borrow();
            file.write_all(&frame).ok();
        }
    });

    ((width, height), capture, rx.await.unwrap())
}

pub fn get_window_bounds(window_number: u32) -> Option<Bounds> {
    let windows = macos::get_on_screen_windows();

    let window = windows
        .into_iter()
        .find(|w| w.window_number == window_number)?;

    Some(Bounds {
        width: window.bounds.width as f64,
        height: window.bounds.height as f64,
        x: window.bounds.x as f64,
        y: window.bounds.y as f64,
    })
}
