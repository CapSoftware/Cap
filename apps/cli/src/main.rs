mod record;

use std::{
    io::{stdout, Write},
    path::PathBuf,
};

use cap_export::ExporterBase;
use cap_media::sources::get_target_fps;
use cap_project::XY;
use clap::{Args, Parser, Subcommand};
use record::RecordStart;
use serde_json::json;
use tracing::*;
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};

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
    // let (layer, handle) = tracing_subscriber::reload::Layer::new(None::<DynLoggingLayer>);

    let registry = tracing_subscriber::registry().with(tracing_subscriber::filter::filter_fn(
        (|v| v.target().starts_with("cap_")) as fn(&tracing::Metadata) -> bool,
    ));

    registry
        // .with(layer)
        .with(
            tracing_subscriber::fmt::layer()
                .with_ansi(true)
                .with_target(true),
        )
        .init();

    let cli = Cli::parse();

    match cli.command {
        Commands::Export(e) => {
            if let Err(e) = e.run().await {
                eprint!("Export failed: {e}")
            }
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
    async fn run(self) -> Result<(), String> {
        let exporter_base = ExporterBase::builder(self.project_path)
            .build()
            .await
            .map_err(|v| format!("Exporter build error: {}", v.to_string()))?;

        let mut stdout = stdout();

        let exporter_output_path = cap_export::mp4::Mp4ExportSettings {
            fps: 10,
            resolution_base: XY::new(1920, 1080),
            compression: cap_export::mp4::ExportCompression::Minimal,
        }
        .export(exporter_base, move |f| {
            print!("\rrendered frame {f}");

            stdout.flush().unwrap();
        })
        .await
        .map_err(|v| format!("Exporter error: {}", v.to_string()))?;

        let output_path = if let Some(output_path) = self.output_path {
            std::fs::copy(&exporter_output_path, &output_path).unwrap();
            output_path
        } else {
            exporter_output_path
        };

        info!("Exported video to '{}'", output_path.display());

        Ok(())
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
