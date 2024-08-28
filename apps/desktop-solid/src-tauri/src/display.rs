use std::{io::Write, path::PathBuf, sync::atomic::Ordering};

use scap::{
    capturer::{Area, Capturer, Options, Point, Resolution, Size},
    frame::{Frame, FrameType},
    Target,
};
use serde::{Deserialize, Serialize};
use specta::Type;

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
#[serde(rename_all = "camelCase")]
pub enum CaptureTarget {
    Screen,
    Window(u32),
}

#[tauri::command]
#[specta::specta]
pub fn get_capture_windows() -> Vec<CaptureWindow> {
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

pub fn start_capturing(
    pipe_path: PathBuf,
    capture_target: &CaptureTarget,
) -> ((u32, u32), NamedPipeCapture) {
    dbg!(capture_target);
    let mut capturer = {
        let crop_area = match capture_target {
            CaptureTarget::Window(window_number) => {
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

        let options = Options {
            fps: FPS,
            show_highlight: true,
            output_type: FrameType::BGRAFrame,
            output_resolution: Resolution::Captured,
            crop_area,
            ..Default::default()
        };

        Capturer::new(dbg!(options))
    };

    let [width, height] = capturer.get_output_frame_size();

    let (capture, is_stopped) = NamedPipeCapture::new(&pipe_path);

    std::thread::spawn(move || {
        capturer.start_capture();

        println!("Opening pipe");
        let mut file = std::fs::File::create(&pipe_path).unwrap();
        println!("Pipe opened");

        loop {
            if is_stopped.load(Ordering::Relaxed) {
                println!("Stopping receiving capture frames");
                return;
            }

            match capturer.get_next_frame() {
                Ok(Frame::BGRA(frame)) => {
                    file.write_all(&frame.data).ok();
                }
                _ => println!("Failed to get frame"),
            }
        }
    });

    ((width, height), capture)
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
