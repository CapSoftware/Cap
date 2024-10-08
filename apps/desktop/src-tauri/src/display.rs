use ffmpeg::{format as avformat, frame::Video, software};
use std::{
    path::PathBuf,
    time::{Instant, SystemTime},
};

use scap::{
    capturer::{Area, Capturer, Options, Point, Resolution, Size},
    frame::{Frame, FrameType},
    Target,
};
use serde::{Deserialize, Serialize};
use specta::Type;
use tokio::sync::{oneshot, watch};

use crate::{
    capture::CaptureController,
    encoder::{bgra_frame, H264Encoder},
    macos,
};

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

// ffmpeg
//     .command
//     .args(["-f", "mp4", "-map", &format!("{}:v", ffmpeg_input.index)])
//     .args(["-codec:v", "libx264", "-preset", "ultrafast"])
//     .args(["-g", &keyframe_interval_str])
//     .args(["-keyint_min", &keyframe_interval_str])
//     .args(["-pix_fmt", "yuv420p", "-tune", "zerolatency"])
//     // .args(["-vsync", "1", "-force_key_frames", "expr:gte(t,n_forced*3)"])
//     // .args(["-movflags", "frag_keyframe+empty_moov"])
//     .args([
//         "-vf",
//         &format!("fps={},scale=in_range=full:out_range=limited", display::FPS),
//     ])
//     .arg(&output_path);

pub async fn start_capturing(
    output_path: PathBuf,
    capture_target: &CaptureTarget,
    start_writing_rx: watch::Receiver<bool>,
) -> CaptureController {
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
            show_cursor: true,
            output_type: FrameType::BGRAFrame,
            output_resolution: Resolution::Captured,
            crop_area,
            excluded_targets: Some(excluded_targets),
            ..Default::default()
        };

        Capturer::new(dbg!(options))
    };

    let controller = CaptureController::new(output_path);

    let (tx, rx) = oneshot::channel();

    std::thread::spawn({
        let controller = controller.clone();
        move || {
            let capture_format = avformat::Pixel::BGRA;
            let output_format = H264Encoder::output_format();

            let capture_size = capturer.get_output_frame_size();
            let frame_size = scale_dimensions(capture_size[0], capture_size[1], 1920);

            let mut encoder = H264Encoder::new(
                &controller.output_path,
                frame_size.0,
                frame_size.1,
                FPS as f64,
            );

            // 1080p scaling via scap causes artifacts on external monitors so ffmpeg it is
            let mut scaler = software::scaling::Context::get(
                capture_format,
                capture_size[0],
                capture_size[1],
                output_format,
                frame_size.0,
                frame_size.1,
                software::scaling::Flags::FAST_BILINEAR,
            )
            .unwrap();

            capturer.start_capture();

            let mut start_time_tx = Some(tx);

            // Hold the last valid RGB frame
            let mut last_rgb_frame: Option<ffmpeg::frame::Video> = None;

            loop {
                if controller.is_stopped() {
                    break;
                }

                let frame = capturer.get_next_frame();

                if controller.is_paused() {
                    continue;
                }

                if let Some(tx) = start_time_tx.take() {
                    tx.send(()).ok();
                }

                if !*start_writing_rx.borrow() {
                    continue;
                }

                match frame {
                    Ok(Frame::BGRA(frame)) => {
                        if let Some(rgb_frame) =
                            bgra_frame(&frame.data, capture_size[0], capture_size[1])
                        {
                            // Successfully created RGB frame
                            last_rgb_frame = Some(rgb_frame.clone());

                            let mut yuv_frame = Video::empty();
                            scaler.run(&rgb_frame, &mut yuv_frame).unwrap();

                            encoder.encode_frame(yuv_frame, frame.display_time / 1_000_000);
                        } else if let Some(ref rgb_frame) = last_rgb_frame {
                            // Use the last valid frame
                            println!("Using last valid frame due to unexpected frame size.");

                            let mut yuv_frame = Video::empty();
                            scaler.run(rgb_frame, &mut yuv_frame).unwrap();

                            // Update the display time to maintain synchronization
                            encoder.encode_frame(yuv_frame, frame.display_time / 1_000_000);
                        } else {
                            // No previous frame to use
                            println!("No valid frame available to use.");
                        }
                    }
                    _ => println!("Failed to get frame"),
                }
            }

            encoder.close();
        }
    });

    rx.await.unwrap(); // wait for first frame

    controller
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

fn scale_dimensions(width: u32, height: u32, max_width: u32) -> (u32, u32) {
    if width <= max_width {
        return (width, height);
    }

    let aspect_ratio = width as f32 / height as f32;
    let new_width = max_width;
    let new_height = (new_width as f32 / aspect_ratio).round() as u32;

    // Ensure dimensions are divisible by 2
    (new_width & !1, new_height & !1)
}
