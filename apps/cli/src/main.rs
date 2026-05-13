mod record;

use std::{
    io::{Write, stderr, stdout},
    path::PathBuf,
    sync::{Arc, Mutex},
};

use cap_export::{ExporterBase, make_cursor_only_project};
use cap_project::RecordingMeta;
use cap_project::XY;
use clap::{Args, Parser, Subcommand};
use record::RecordStart;
use serde::{Deserialize, Serialize};
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
    /// Render an export preview frame
    ExportPreview(ExportPreview),
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
                .with_target(true)
                .with_writer(stderr),
        )
        .init();

    let cli = Cli::parse();

    match cli.command {
        Commands::Export(e) => {
            e.run().await?;
        }
        Commands::ExportPreview(e) => {
            e.run().await?;
        }
        Commands::Record(RecordArgs { command, args }) => match command {
            Some(RecordCommands::Screens) => {
                let screens = cap_recording::screen_capture::list_displays();

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
                        target.refresh_rate()
                    );
                }
            }
            Some(RecordCommands::Windows) => {
                let windows = cap_recording::screen_capture::list_windows();

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
                        target.display().unwrap().refresh_rate()
                    );
                }
            }
            Some(RecordCommands::Cameras) => {
                let cameras = cap_camera::list_cameras().collect::<Vec<_>>();

                let mut info = vec![];
                for camera_info in cameras {
                    // let format = RequestedFormat::new::<RgbAFormat>(
                    //     RequestedFormatType::AbsoluteHighestFrameRate,
                    // );

                    // let Ok(mut camera) = Camera::new(camera_info.index().clone(), format) else {
                    //     continue;
                    // };

                    info.push(json!({
                        // "model_id": camera_info.model_id().to_string(),
                        "display_name": camera_info.display_name()
                        // "index": camera_info.index().to_string(),
                        // "name": camera_info.human_name(),
                        // "pixel_format": camera.frame_format(),
                        // "formats":  camera
                        // 		.compatible_camera_formats()
                        //   	.unwrap()
                        //    	.into_iter()
                        //     .map(|f| format!("{}x{}@{}fps", f.resolution().x(), f.resolution().y(), f.frame_rate()))
                        //     .collect::<Vec<_>>()
                    }));
                }

                println!("{}", serde_json::to_string_pretty(&info).unwrap());
            }
            None => {
                args.run().await?;
            }
        },
    }

    Ok(())
}

#[derive(Args)]
struct Export {
    project_path: PathBuf,
    output_path: Option<PathBuf>,
    #[arg(long)]
    settings_json: Option<String>,
    #[arg(long)]
    force_ffmpeg_decoder: bool,
    #[arg(long)]
    progress_json: bool,
}

#[derive(Args)]
struct ExportPreview {
    project_path: PathBuf,
    #[arg(long)]
    frame_time: f64,
    #[arg(long)]
    settings_json: String,
    #[arg(long)]
    force_ffmpeg_decoder: bool,
}

#[derive(Deserialize)]
#[serde(tag = "format")]
enum CliExportSettings {
    Mp4(cap_export::mp4::Mp4ExportSettings),
    Gif(cap_export::gif::GifExportSettings),
    Mov(cap_export::mov::MovExportSettings),
}

impl CliExportSettings {
    fn default_mp4() -> Self {
        Self::Mp4(cap_export::mp4::Mp4ExportSettings {
            fps: 60,
            resolution_base: XY::new(1920, 1080),
            compression: cap_export::mp4::ExportCompression::Maximum,
            custom_bpp: None,
            force_ffmpeg_decoder: false,
            optimize_filesize: false,
        })
    }

    fn fps(&self) -> u32 {
        match self {
            Self::Mp4(settings) => settings.fps,
            Self::Gif(settings) => settings.fps,
            Self::Mov(settings) => settings.fps,
        }
    }

    fn force_ffmpeg_decoder(&self) -> bool {
        match self {
            Self::Mp4(settings) => settings.force_ffmpeg_decoder,
            Self::Gif(_) | Self::Mov(_) => false,
        }
    }

    fn cursor_only(&self) -> bool {
        match self {
            Self::Mov(settings) => settings.cursor_only,
            Self::Mp4(_) | Self::Gif(_) => false,
        }
    }
}

#[derive(Serialize)]
#[serde(tag = "type")]
enum ExportProgressMessage<'a> {
    Progress {
        rendered_count: u32,
        total_frames: u32,
    },
    Completed {
        path: &'a std::path::Path,
    },
}

impl Export {
    async fn run(self) -> Result<(), String> {
        let settings = self
            .settings_json
            .as_deref()
            .map(serde_json::from_str)
            .transpose()
            .map_err(|e| format!("Invalid export settings JSON: {e}"))?
            .unwrap_or_else(CliExportSettings::default_mp4);

        let force_ffmpeg_decoder = self.force_ffmpeg_decoder || settings.force_ffmpeg_decoder();
        let mut builder = ExporterBase::builder(self.project_path.clone())
            .with_force_ffmpeg_decoder(force_ffmpeg_decoder);

        if let Some(output_path) = self.output_path {
            builder = builder.with_output_path(output_path);
        }

        if settings.cursor_only() {
            let meta = RecordingMeta::load_for_project(&self.project_path)
                .map_err(|e| format!("Failed to load recording meta: {e}"))?;
            builder = builder.with_config(make_cursor_only_project(meta.project_config()));
        }

        let exporter_base = builder
            .build()
            .await
            .map_err(|v| format!("Exporter build error: {v}"))?;

        let total_frames = exporter_base.total_frames(settings.fps());
        let progress_json = self.progress_json;
        let stdout = Arc::new(Mutex::new(stdout()));

        if progress_json {
            emit_export_message(
                &stdout,
                &ExportProgressMessage::Progress {
                    rendered_count: 0,
                    total_frames,
                },
            )?;
        }

        let progress_stdout = Arc::clone(&stdout);
        let on_progress = move |frame_index: u32| {
            if progress_json {
                emit_export_message(
                    &progress_stdout,
                    &ExportProgressMessage::Progress {
                        rendered_count: (frame_index + 1).min(total_frames),
                        total_frames,
                    },
                )
                .is_ok()
            } else {
                true
            }
        };

        let output_path = match settings {
            CliExportSettings::Mp4(settings) => settings.export(exporter_base, on_progress).await,
            CliExportSettings::Gif(settings) => settings.export(exporter_base, on_progress).await,
            CliExportSettings::Mov(settings) => settings.export(exporter_base, on_progress).await,
        }
        .map_err(|v| format!("Exporter error: {v}"))?;

        if self.progress_json {
            emit_export_message(
                &stdout,
                &ExportProgressMessage::Completed { path: &output_path },
            )?;
        }

        info!("Exported video to '{}'", output_path.display());

        Ok(())
    }
}

impl ExportPreview {
    async fn run(self) -> Result<(), String> {
        let settings =
            serde_json::from_str::<cap_export::preview::ExportPreviewSettings>(&self.settings_json)
                .map_err(|e| format!("Invalid preview settings JSON: {e}"))?;
        let result = cap_export::preview::render_preview(
            self.project_path,
            self.frame_time,
            settings,
            self.force_ffmpeg_decoder,
        )
        .await
        .map_err(|e| format!("Preview render error: {e}"))?;

        let mut stdout = stdout();
        serde_json::to_writer(&mut stdout, &result).map_err(|e| e.to_string())?;
        writeln!(&mut stdout).map_err(|e| e.to_string())?;
        stdout.flush().map_err(|e| e.to_string())
    }
}

fn emit_export_message(
    stdout: &Arc<Mutex<std::io::Stdout>>,
    message: &ExportProgressMessage<'_>,
) -> Result<(), String> {
    let mut stdout = stdout
        .lock()
        .map_err(|_| "Failed to lock stdout".to_string())?;
    serde_json::to_writer(&mut *stdout, message).map_err(|e| e.to_string())?;
    writeln!(&mut *stdout).map_err(|e| e.to_string())?;
    stdout.flush().map_err(|e| e.to_string())
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
