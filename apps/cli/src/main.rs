mod auth;
mod config;
#[cfg(feature = "record")]
mod daemon;
mod feedback;
mod orgs;
#[cfg(feature = "record")]
mod record;
mod s3;
#[cfg(feature = "record")]
mod system_info;
mod upload_cmd;
mod videos;

#[cfg(feature = "record")]
use std::{
    io::{Write, stdout},
    path::PathBuf,
};

#[cfg(feature = "record")]
use clap::Args;
use clap::{Parser, Subcommand};
#[cfg(feature = "record")]
use record::RecordStart;
#[cfg(feature = "record")]
use serde_json::json;
#[cfg(feature = "record")]
use tracing::*;
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};

#[derive(Parser)]
#[command(name = "cap", about = "Screen recording and sharing")]
struct Cli {
    #[arg(long, global = true)]
    json: bool,

    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand)]
enum Commands {
    #[cfg(feature = "record")]
    Export(Export),
    #[cfg(feature = "record")]
    Record(RecordArgs),
    Auth(auth::AuthArgs),
    Upload(upload_cmd::UploadArgs),
    Config(config::ConfigArgs),
    Feedback(feedback::FeedbackArgs),
    Debug(feedback::DebugArgs),
    #[cfg(feature = "record")]
    SystemInfo(system_info::SystemInfoArgs),
    List(videos::ListArgs),
    Get(videos::GetArgs),
    Delete(videos::DeleteArgs),
    Open(videos::OpenArgs),
    Info(videos::InfoArgs),
    Transcript(videos::TranscriptArgs),
    Password(videos::PasswordArgs),
    Orgs(orgs::OrgsArgs),
    S3(s3::S3Args),
}

#[cfg(feature = "record")]
#[derive(Args)]
#[command(args_conflicts_with_subcommands = true)]
struct RecordArgs {
    #[command(subcommand)]
    command: Option<RecordCommands>,

    #[command(flatten)]
    args: RecordStart,
}

#[cfg(feature = "record")]
#[derive(Subcommand)]
enum RecordCommands {
    Screens,
    Windows,
    Cameras,
    Start(record::RecordStart),
    Stop,
    Status,
}

#[tokio::main]
async fn main() -> Result<(), String> {
    let registry = tracing_subscriber::registry().with(tracing_subscriber::filter::filter_fn(
        (|v| v.target().starts_with("cap_") || v.target().starts_with("cap"))
            as fn(&tracing::Metadata) -> bool,
    ));

    let log_dir = feedback::log_dir();
    let file_layer = std::fs::create_dir_all(&log_dir)
        .ok()
        .and_then(|_| {
            std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(feedback::log_path())
                .ok()
        })
        .map(|file| {
            tracing_subscriber::fmt::layer()
                .with_ansi(false)
                .with_target(true)
                .with_writer(std::sync::Mutex::new(file))
        });

    registry
        .with(
            tracing_subscriber::fmt::layer()
                .with_ansi(true)
                .with_target(true),
        )
        .with(file_layer)
        .init();

    let cli = Cli::parse();
    let json_output = cli.json;

    match cli.command {
        #[cfg(feature = "record")]
        Commands::Export(e) => {
            if let Err(e) = e.run().await {
                eprint!("Export failed: {e}")
            }
        }
        #[cfg(feature = "record")]
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
                    info.push(json!({
                        "display_name": camera_info.display_name()
                    }));
                }

                println!("{}", serde_json::to_string_pretty(&info).unwrap());
            }
            Some(RecordCommands::Start(start_args)) => {
                record::start_daemon(start_args, json_output).await?;
            }
            Some(RecordCommands::Stop) => {
                record::stop_recording(json_output).await?;
            }
            Some(RecordCommands::Status) => {
                record::recording_status(json_output).await?;
            }
            None => {
                args.run().await?;
            }
        },
        Commands::Auth(a) => a.run(json_output).await?,
        Commands::Upload(u) => u.run(json_output).await?,
        Commands::Config(c) => c.run(json_output).await?,
        Commands::Feedback(f) => f.run(json_output).await?,
        Commands::Debug(d) => d.run(json_output).await?,
        #[cfg(feature = "record")]
        Commands::SystemInfo(s) => s.run(json_output).await?,
        Commands::List(l) => l.run(json_output).await?,
        Commands::Get(g) => g.run(json_output).await?,
        Commands::Delete(d) => d.run(json_output).await?,
        Commands::Open(o) => o.run(json_output).await?,
        Commands::Info(i) => i.run(json_output).await?,
        Commands::Transcript(t) => t.run(json_output).await?,
        Commands::Password(p) => p.run(json_output).await?,
        Commands::Orgs(o) => o.run(json_output).await?,
        Commands::S3(s) => s.run(json_output).await?,
    }

    Ok(())
}

#[cfg(feature = "record")]
#[derive(Args)]
struct Export {
    project_path: PathBuf,
    output_path: Option<PathBuf>,
}

#[cfg(feature = "record")]
impl Export {
    async fn run(self) -> Result<(), String> {
        let exporter_base = cap_export::ExporterBase::builder(self.project_path)
            .build()
            .await
            .map_err(|v| format!("Exporter build error: {v}"))?;

        let mut stdout = stdout();

        let exporter_output_path = cap_export::mp4::Mp4ExportSettings {
            fps: 60,
            resolution_base: cap_project::XY::new(1920, 1080),
            compression: cap_export::mp4::ExportCompression::Maximum,
            custom_bpp: None,
            force_ffmpeg_decoder: false,
        }
        .export(exporter_base, move |_f| {
            stdout.flush().unwrap();
            true
        })
        .await
        .map_err(|v| format!("Exporter error: {v}"))?;

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
