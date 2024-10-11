use ffmpeg::{format as avformat, frame::Video, software};
use std::path::PathBuf;

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

// use std::collections::HashSet;
// use tauri::command;

#[derive(Type, Serialize)]
pub struct CaptureScreen {
    id: u32,
    name: String,
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
pub fn list_capture_screens() -> Vec<CaptureScreen> {
    if !scap::has_permission() {
        return vec![];
    }

    let mut targets = vec![];
    let screens = scap::get_all_targets();

    for (idx, target) in screens.into_iter().enumerate() {
        // Handle Target::Screen variant (assuming this is how it's structured in scap)
        if let Target::Display(screen) = target {
            // Only add the screen if it hasn't been added already
            targets.push(CaptureScreen {
                id: screen.id as u32,
                name: format!("Screen {}", idx + 1),
            });
        }
    }
    targets
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
        .map(|scap_window| {
            // Find the corresponding window to get the application name
            let app_name = windows
                .iter()
                .find(|window| window.window_number == scap_window.raw_handle)
                .map(|window| window.owner_name.clone())
                .unwrap_or(scap_window.title.clone());
            CaptureWindow {
                id: scap_window.id,
                name: app_name,
            }
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

    // Bring the window into focus if we're capturing a window
    if let CaptureTarget::Window { id: window_number } = capture_target {
        bring_window_to_focus(*window_number);
    }

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
                            let mut yuv_frame = Video::empty();
                            scaler.run(&rgb_frame, &mut yuv_frame).unwrap();

                            encoder.encode_frame(yuv_frame, frame.display_time / 1_000_000);
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

use crate::macos::get_on_screen_windows;
use std::io::Write;
use std::process::Command;
use tempfile::NamedTempFile;

fn bring_window_to_focus(window_id: u32) {
    println!("Attempting to bring window {} to focus", window_id);

    // Get the window information associated with the window id
    let windows = get_on_screen_windows();
    if let Some(window) = windows.into_iter().find(|w| w.window_number == window_id) {
        let process_id = window.process_id;
        let window_title = window.name.clone();
        let bounds_x = window.bounds.x;
        let bounds_y = window.bounds.y;
        let bounds_width = window.bounds.width;
        let bounds_height = window.bounds.height;
        let should_focus = true;

        // Prepare the AppleScript
        let apple_script = r#"
        on run argv
            set processId to item 1 of argv as number
            set windowTitle to item 2 of argv
            set boundsX to item 3 of argv as number
            set boundsY to item 4 of argv as number
            set boundsWidth to item 5 of argv as number
            set boundsHeight to item 6 of argv as number
            set shouldFocus to item 7 of argv as boolean or true

            log "processId: " & processId
            log "windowTitle: " & windowTitle
            log "boundsX: " & boundsX
            log "boundsY: " & boundsY
            log "boundsWidth: " & boundsWidth
            log "boundsHeight: " & boundsHeight

            tell application "System Events"
                set appProcess to first process whose unix id is processId
                set frontmost of appProcess to true

                tell appProcess
                    set appWindowsCount to count of windows
                    log "appWindowsCount: " & appWindowsCount

                    if appWindowsCount is equal to 1 then
                        perform action "AXRaise" of first window
                        log "--found window--"
                        return
                    end if

                    repeat with checkedWindow in windows
                        tell checkedWindow
                            if title contains windowTitle and position is equal to {boundsX, boundsY} and size is equal to {boundsWidth, boundsHeight} then
                                perform action "AXRaise" of checkedWindow
                                log "--found window--"
                                exit repeat
                            end if
                        end tell
                    end repeat
                end tell
            end tell
        end run
        "#;

        // Prepare arguments
        let args = vec![
            process_id.to_string(),
            window_title.clone(),
            bounds_x.to_string(),
            bounds_y.to_string(),
            bounds_width.to_string(),
            bounds_height.to_string(),
            should_focus.to_string(),
        ];

        // Write the AppleScript to a temporary file
        let mut script_file = NamedTempFile::new().expect("Failed to create temp file");
        script_file
            .write_all(apple_script.as_bytes())
            .expect("Failed to write to temp file");

        // Execute the AppleScript with arguments
        let output = Command::new("osascript")
            .arg(script_file.path())
            .args(&args)
            .output();

        match output {
            Ok(output) => {
                if output.status.success() {
                    println!("Successfully executed AppleScript");
                } else {
                    let error_message = String::from_utf8_lossy(&output.stderr);
                    eprintln!("AppleScript execution failed: {}", error_message);
                }
            }
            Err(e) => eprintln!("Failed to execute AppleScript: {}", e),
        }

        println!("Finished attempt to bring window {} to focus", window_id);
    } else {
        eprintln!("Window with id {} not found", window_id);
    }
}
