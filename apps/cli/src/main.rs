mod record;

use std::{path::PathBuf, sync::Arc};

use cap_editor::create_segments;
use cap_media::sources::get_target_fps;
use cap_project::{RecordingMeta, XY};
use cap_rendering::RenderVideoConstants;
use clap::{Args, Parser, Subcommand};
use record::RecordStart;
use serde_json::json;
use tracing::*;

#[derive(Parser)]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand)]
enum Commands {
    /// Export a '.cap' project to an mp4 file
    Export(Export),
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
    args: RecordStart,
}

#[derive(Subcommand)]
enum RecordCommands {
    /// List screens available for capturing
    Screens,
    /// List windows available for capturing
    Windows,
    /// List cameras available for capturing
    Cameras,
    // Mics,
}

#[tokio::main]
async fn main() -> Result<(), String> {
    let cli = Cli::parse();

    match cli.command {
        Commands::Export(e) => e.run().await,
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
            Some(RecordCommands::Cameras) => {
                use nokhwa::{
                    pixel_format::RgbAFormat,
                    utils::{ApiBackend, RequestedFormat, RequestedFormatType},
                    Camera,
                };

                let cameras = nokhwa::query(ApiBackend::Auto).unwrap();

                let mut info = vec![];
                for camera_info in cameras {
                    let format = RequestedFormat::new::<RgbAFormat>(
                        RequestedFormatType::AbsoluteHighestFrameRate,
                    );

                    let Ok(mut camera) = Camera::new(camera_info.index().clone(), format) else {
                        continue;
                    };

                    info.push(json!({
                        "index": camera_info.index().to_string(),
                        "name": camera_info.human_name(),
                        "pixel_format": camera.frame_format(),
                        "formats":  camera
                        		.compatible_camera_formats()
                          	.unwrap()
                           	.into_iter()
                            .map(|f| format!("{}x{}@{}fps", f.resolution().x(), f.resolution().y(), f.frame_rate()))
                            .collect::<Vec<_>>()
                    }));
                }

                println!("{}", serde_json::to_string_pretty(&info).unwrap());
            }
            None => {
                args.run().await?;
            }
            _ => {}
        },
    }

    Ok(())
}

#[derive(Args)]
struct Export {
    project_path: PathBuf,
    output_path: Option<PathBuf>,
}

impl Export {
    async fn run(self) {
        let project = serde_json::from_reader(
            std::fs::File::open(self.project_path.join("project-config.json")).unwrap(),
        )
        .unwrap();

        let recording_meta = RecordingMeta::load_for_project(&self.project_path).unwrap();
        let meta = recording_meta.studio_meta().unwrap();
        let recordings = cap_rendering::ProjectRecordings::new(&recording_meta, meta);

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
            RenderVideoConstants::new(render_options, &recording_meta, meta)
                .await
                .unwrap(),
        );

        let segments = create_segments(&recording_meta, meta).await.unwrap();

        let fps = meta.max_fps();
        let project_output_path = self.project_path.join("output/result.mp4");
        let exporter = cap_export::Exporter::new(
            project,
            project_output_path.clone(),
            |_| {},
            self.project_path.clone(),
            recording_meta,
            render_constants,
            &segments,
            fps,
            XY::new(1920, 1080),
            true,
        )
        .await
        .unwrap();

        exporter.export_with_custom_muxer().await.unwrap();

        let output_path = if let Some(output_path) = self.output_path {
            std::fs::copy(&project_output_path, &output_path).unwrap();
            output_path
        } else {
            project_output_path
        };

        println!("Exported video to '{}'", output_path.display());
    }
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
