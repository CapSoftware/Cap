use std::{env::current_dir, path::PathBuf, sync::Arc};

use cap_editor::create_segments;
use cap_media::sources::{get_target_fps, ScreenCaptureTarget};
use cap_project::{RecordingMeta, XY};
use cap_recording::RecordingOptions;
use cap_rendering::RenderVideoConstants;
use clap::{Args, Parser, Subcommand};
use instrument::WithSubscriber;
use tokio::io::AsyncBufReadExt;
use tracing::*;
use uuid::Uuid;

#[derive(Parser)]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand)]
enum Commands {
    /// Export a '.cap' project to an mp4 file
    Export {
        project_path: PathBuf,
        output_path: Option<PathBuf>,
    },
    /// Start a recording or list available capture targets and devices
    Record(RecordArgs),
}

#[derive(Args)]
#[command(args_conflicts_with_subcommands = true)]
// #[command(flatten_help = true)]
struct RecordArgs {
    #[command(subcommand)]
    command: Option<RecordCommands>,

    #[command(flatten)]
    args: RecordStartArgs,
}

#[derive(Subcommand)]
enum RecordCommands {
    /// List screens available for capturing
    Screens,
    /// List windows available for capturing
    Windows,
    // Cameras,
    // Mics,
}

#[derive(Args)]
struct RecordStartArgs {
    #[command(flatten)]
    target: RecordTargets,
    /// ID of the camera to record
    #[arg(long)]
    camera: Option<u32>,
    /// ID of the microphone to record
    #[arg(long)]
    mic: Option<u32>,
    #[arg(long)]
    /// Path to save the '.cap' project to
    path: Option<PathBuf>,
    /// Maximum fps to record at (max 60)
    #[arg(long)]
    fps: Option<u32>,
}

#[derive(Args)]
struct RecordTargets {
    /// ID of the screen to capture
    #[arg(long, group = "target")]
    screen: Option<u32>,
    /// ID of the window to capture
    #[arg(long, group = "target")]
    window: Option<u32>,
}

#[tokio::main]
async fn main() -> Result<(), String> {
    let cli = Cli::parse();

    match cli.command {
        Commands::Export {
            project_path,
            output_path,
        } => {
            let project = serde_json::from_reader(
                std::fs::File::open(project_path.join("project-config.json")).unwrap(),
            )
            .unwrap();

            let meta = RecordingMeta::load_for_project(&project_path).unwrap();
            let recordings = cap_rendering::ProjectRecordings::new(&meta);

            let render_options = cap_rendering::RenderOptions {
                screen_size: XY::new(
                    recordings.segments[0].display.width,
                    recordings.segments[0].display.height,
                ),
                camera_size: recordings.segments[0]
                    .camera
                    .as_ref()
                    .map(|c| XY::new(c.width, c.height)),
            };
            let render_constants = Arc::new(
                RenderVideoConstants::new(render_options, &meta)
                    .await
                    .unwrap(),
            );

            let segments = create_segments(&meta);

            let fps = meta.content.max_fps();
            let project_output_path = project_path.join("output/result.mp4");
            let exporter = cap_export::Exporter::new(
                project,
                project_output_path.clone(),
                |_| {},
                project_path.clone(),
                meta,
                render_constants,
                &segments,
                fps,
                XY::new(1920, 1080),
                true,
            )
            .unwrap();

            exporter.export_with_custom_muxer().await.unwrap();

            let output_path = if let Some(output_path) = output_path {
                std::fs::copy(&project_output_path, &output_path).unwrap();
                output_path
            } else {
                project_output_path
            };

            println!("Exported video to '{}'", output_path.display());
        }
        Commands::Record(RecordArgs { command, args }) => match command {
            Some(RecordCommands::Screens) => {
                let screens = cap_media::sources::list_screens();

                for (i, (screen, target)) in screens.iter().enumerate() {
                    println!(
                        "
screen {}:
  id: {}
  name: {}
  fps: {}",
                        i,
                        screen.id,
                        screen.name,
                        get_target_fps(target).unwrap()
                    );
                }
            }
            Some(RecordCommands::Windows) => {
                let windows = cap_media::sources::list_windows();

                for (i, (window, target)) in windows.iter().enumerate() {
                    println!(
                        "
window {}:
  id: {}
  name: {}
  fps: {}",
                        i,
                        window.id,
                        window.name,
                        get_target_fps(target).unwrap()
                    );
                }
            }
            None => {
                let (target_info, scap_target) = args
                    .target
                    .screen
                    .map(|id| {
                        cap_media::sources::list_screens()
                            .into_iter()
                            .find(|s| s.0.id == id)
                            .map(|(s, t)| (ScreenCaptureTarget::Screen(s), t))
                            .ok_or(format!("Screen with id '{id}' not found"))
                    })
                    .or_else(|| {
                        args.target.window.map(|id| {
                            cap_media::sources::list_windows()
                                .into_iter()
                                .find(|s| s.0.id == id)
                                .map(|(s, t)| (ScreenCaptureTarget::Window(s), t))
                                .ok_or(format!("Window with id '{id}' not found"))
                        })
                    })
                    .ok_or("No target specified".to_string())??;

                let id = Uuid::new_v4().to_string();
                let path = args
                    .path
                    .unwrap_or_else(|| current_dir().unwrap().join(format!("{id}.cap")));

                let actor = cap_recording::spawn_recording_actor(
                    id,
                    path,
                    RecordingOptions {
                        capture_target: target_info,
                        camera_label: None,
                        audio_input_name: None,
                        fps: 30,
                        output_resolution: None,
                    },
                    None,
                    None,
                )
                .await
                .map_err(|e| e.to_string())?;

                info!("Recording starting, press Enter to stop");

                tokio::io::BufReader::new(tokio::io::stdin())
                    .read_line(&mut String::new())
                    .await
                    .unwrap();

                info!("Recording stopped");

                actor.stop().await.unwrap();
            }
            _ => {}
        },
    }

    Ok(())
}

// fn ffmpeg_callback_experiment() {
//     unsafe {
//         unsafe extern "C" fn ffmpeg_log_callback(
//             arg1: *mut std::ffi::c_void,
//             arg2: std::ffi::c_int,
//             arg3: *const std::ffi::c_char,
//             arg4: *mut std::ffi::c_char,
//         ) {
//             // ffmpeg::sys::AVClass;

//             if !arg1.is_null() {
//                 let arg1_ptr = arg1;
//                 let arg1 = **(arg1 as *mut *mut AVClass);
//                 dbg!(CStr::from_ptr(arg1.class_name));
//                 if let Some(item_name_fn) = arg1.item_name {
//                     dbg!(CStr::from_ptr(item_name_fn(arg1_ptr)));
//                 }
//             }

//             // let class_name = if !arg1.is_null() {
//             //     CStr::from_ptr((*arg1).class_name)
//             // } else {
//             //     "unknown".to_string()
//             // };

//             // println!("[{class_name}] {arg2} {s:?}",);
//         }

//         ffmpeg::sys::av_log_set_callback(Some(ffmpeg_log_callback));
//     }
// }
