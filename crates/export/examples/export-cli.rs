use std::{fmt::Display, path::PathBuf, time::Instant};

use cap_export::{ExporterBase, gif::GifExportSettings, mp4::Mp4ExportSettings};
use clap::{Parser, ValueEnum};
use specta::NamedType;

#[derive(Parser, Debug)]
struct Cli {
    path: PathBuf,
    #[arg(value_enum)]
    format: Option<ExportFormat>,
    settings: Option<String>,
}

#[derive(Copy, Clone, PartialEq, Eq, PartialOrd, Ord, ValueEnum, Debug)]
#[allow(clippy::upper_case_acronyms)]
enum ExportFormat {
    MP4,
    GIF,
}

impl Display for ExportFormat {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::GIF => write!(f, "gif"),
            Self::MP4 => write!(f, "mp4"),
        }
    }
}

#[tokio::main]
async fn main() {
    let cli = Cli::parse();

    let path: PathBuf = std::env::args().collect::<Vec<_>>().swap_remove(1).into();

    let base = ExporterBase::builder(path).build().await.unwrap();

    let format = cli.format.unwrap_or_else(|| {
        inquire::Select::new(
            "Select export format",
            vec![ExportFormat::MP4, ExportFormat::GIF],
        )
        .prompt()
        .unwrap()
    });

    let settings_str = cli.settings;

    match format {
        ExportFormat::GIF => {
            let settings: GifExportSettings = settings_str
                .map(|v| serde_json::from_str(&v).unwrap())
                .unwrap_or(GifExportSettings::default());
            let total_frames = base.total_frames(settings.fps);
            let start = Instant::now();
            settings
                .export(base, move |progress| {
                    print!("Exporting frame {progress} of {total_frames}\r");
                })
                .await
                .unwrap();
            println!("Exported in {:?}", start.elapsed());
        }
        ExportFormat::MP4 => {
            let settings: Mp4ExportSettings = settings_str
                .map(|v| serde_json::from_str(&v).unwrap())
                .unwrap_or(Mp4ExportSettings::default());
            let total_frames = base.total_frames(settings.fps);
            let start = Instant::now();
            settings
                .export(base, move |progress| {
                    print!("Exporting frame {progress} of {total_frames}\r");
                })
                .await
                .unwrap();
            println!("Exported in {:?}", start.elapsed());
        }
    }
}
