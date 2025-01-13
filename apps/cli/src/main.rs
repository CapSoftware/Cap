use std::{path::PathBuf, sync::Arc};

use cap_editor::create_segments;
use cap_media::sources::get_target_fps;
use cap_project::{RecordingMeta, XY};
use cap_rendering::RenderVideoConstants;
use clap::{Parser, Subcommand};

#[derive(Parser)]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand)]
enum Commands {
    Export {
        project_path: PathBuf,
        output_path: Option<PathBuf>,
    },
    Record {
        #[command(subcommand)]
        command: Option<RecordCommands>,
    },
}

#[derive(Subcommand)]
enum RecordCommands {
    Screens,
    Windows,
    Cameras,
    Mics,
}

#[tokio::main]
async fn main() {
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
        Commands::Record { command } => match command {
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
            _ => {}
        },
    }
}
