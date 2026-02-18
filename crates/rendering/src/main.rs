use anyhow::{Context, Result};
use cap_project::{ProjectConfiguration, RecordingMeta, StudioRecordingMeta, XY};
use cap_rendering::{
    ProjectRecordingsMeta, RecordingSegmentDecoders, RenderSegment, RenderVideoConstants,
    RenderedFrame, SegmentVideoPaths,
};
use clap::{Parser, ValueEnum};
use image::{ImageBuffer, ImageFormat};
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::mpsc;

#[derive(Parser, Debug)]
#[command(author, version, about, long_about = None)]
struct Args {
    /// Path to the Cap project directory
    project_path: PathBuf,

    /// Output format for the rendered frame
    #[arg(short, long, default_value = "png")]
    format: OutputFormat,

    /// Output file path (defaults to frame.png/jpeg/raw in current directory)
    #[arg(short, long)]
    output: Option<PathBuf>,

    /// Output resolution width (defaults to project resolution)
    #[arg(long)]
    width: Option<u32>,

    /// Output resolution height (defaults to project resolution)
    #[arg(long)]
    height: Option<u32>,
}

#[derive(Copy, Clone, PartialEq, Eq, PartialOrd, Ord, ValueEnum, Debug)]
enum OutputFormat {
    /// PNG format (lossless, supports transparency)
    Png,
    /// JPEG format (lossy compression)
    Jpeg,
    /// Raw RGBA data
    Raw,
}

impl std::fmt::Display for OutputFormat {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            OutputFormat::Png => write!(f, "png"),
            OutputFormat::Jpeg => write!(f, "jpeg"),
            OutputFormat::Raw => write!(f, "raw"),
        }
    }
}

#[tokio::main]
async fn main() -> Result<()> {
    let args = Args::parse();

    // Load the project similar to ExporterBase
    println!("Loading project from: {}", args.project_path.display());

    let project_config: ProjectConfiguration = serde_json::from_reader(
        std::fs::File::open(args.project_path.join("project-config.json"))
            .context("Failed to open project-config.json")?,
    )
    .context("Failed to parse project configuration")?;

    let recording_meta = RecordingMeta::load_for_project(&args.project_path)
        .map_err(|e| anyhow::anyhow!("Failed to load recording metadata: {}", e))?;
    let studio_meta = recording_meta
        .studio_meta()
        .context("Project is not a studio recording")?
        .clone();

    let recordings = Arc::new(
        ProjectRecordingsMeta::new(&recording_meta.project_path, &studio_meta)
            .map_err(|e| anyhow::anyhow!("Failed to create project recordings meta: {}", e))?,
    );

    let render_constants = Arc::new(
        RenderVideoConstants::new(
            &recordings.segments,
            recording_meta.clone(),
            studio_meta.clone(),
        )
        .await
        .context("Failed to create render constants")?,
    );

    let render_segments: Vec<RenderSegment> = match &studio_meta {
        StudioRecordingMeta::SingleSegment { segment } => {
            let decoders = RecordingSegmentDecoders::new(
                &recording_meta,
                &studio_meta,
                SegmentVideoPaths {
                    display: recording_meta.path(&segment.display.path),
                    camera: segment
                        .camera
                        .as_ref()
                        .map(|c| recording_meta.path(&c.path)),
                },
                0,
                false,
            )
            .await
            .map_err(|e| anyhow::anyhow!("Failed to create decoders for single segment: {}", e))?;

            vec![RenderSegment {
                cursor: Arc::new(Default::default()),
                keyboard: Arc::new(Default::default()),
                decoders,
            }]
        }
        StudioRecordingMeta::MultipleSegments { inner, .. } => {
            let mut segments = Vec::new();
            for (i, s) in inner.segments.iter().enumerate() {
                let decoders = RecordingSegmentDecoders::new(
                    &recording_meta,
                    &studio_meta,
                    SegmentVideoPaths {
                        display: recording_meta.path(&s.display.path),
                        camera: s.camera.as_ref().map(|c| recording_meta.path(&c.path)),
                    },
                    i,
                    false,
                )
                .await
                .map_err(|e| {
                    anyhow::anyhow!("Failed to create decoders for segment {}: {}", i, e)
                })?;

                let cursor = Arc::new(s.cursor_events(&recording_meta));
                let keyboard = Arc::new(s.keyboard_events(&recording_meta));

                segments.push(RenderSegment { cursor, keyboard, decoders });
            }
            segments
        }
    };

    // Determine output size
    let output_size = if let (Some(width), Some(height)) = (args.width, args.height) {
        (width, height)
    } else {
        (1920, 1080) // Default resolution
    };

    // Determine output path
    let output_path = args.output.unwrap_or_else(|| {
        let extension = match args.format {
            OutputFormat::Png => "png",
            OutputFormat::Jpeg => "jpg",
            OutputFormat::Raw => "raw",
        };
        PathBuf::from(format!("frame.{extension}"))
    });

    // Ensure output directory exists
    if let Some(parent) = output_path.parent() {
        std::fs::create_dir_all(parent).context("Failed to create output directory")?;
    }

    println!(
        "Rendering first frame at {}x{}",
        output_size.0, output_size.1
    );
    println!("Output: {}", output_path.display());

    // Set up rendering pipeline
    let (tx, mut rx) = mpsc::channel::<(RenderedFrame, u32)>(1);

    // Start rendering in a separate task
    let render_task = tokio::task::spawn(async move {
        cap_rendering::render_video_to_channel(
            &render_constants,
            &project_config,
            tx,
            &recording_meta.clone(),
            &studio_meta,
            render_segments,
            1, // Only render 1 frame
            XY::new(output_size.0, output_size.1),
            &recordings,
        )
        .await
    });

    // Wait for the first frame
    let (frame, frame_number) = rx
        .recv()
        .await
        .ok_or_else(|| anyhow::anyhow!("No frame received"))?;
    println!(
        "Received frame {} ({}x{})",
        frame_number, frame.width, frame.height
    );

    // Cancel the render task since we only want the first frame
    render_task.abort();

    // Save the frame in the requested format
    match args.format {
        OutputFormat::Png => save_as_png(&frame, &output_path)?,
        OutputFormat::Jpeg => save_as_jpeg(&frame, &output_path)?,
        OutputFormat::Raw => save_as_raw(&frame, &output_path)?,
    }

    println!("✅ Frame saved to: {}", output_path.display());
    Ok(())
}

fn save_as_png(frame: &RenderedFrame, output_path: &PathBuf) -> Result<()> {
    // Use RGBA data directly for PNG to preserve transparency
    let rgba_data: Vec<u8> = frame
        .data
        .chunks(frame.padded_bytes_per_row as usize)
        .flat_map(|row| row[0..(frame.width * 4) as usize].to_vec())
        .collect();

    let rgba_img =
        ImageBuffer::<image::Rgba<u8>, Vec<u8>>::from_raw(frame.width, frame.height, rgba_data)
            .context("Failed to create image from frame data")?;

    rgba_img
        .save_with_format(output_path, ImageFormat::Png)
        .context("Failed to save PNG")?;
    Ok(())
}

fn save_as_jpeg(frame: &RenderedFrame, output_path: &PathBuf) -> Result<()> {
    // Convert RGBA data to RGB for JPEG
    let rgb_data: Vec<u8> = frame
        .data
        .chunks(frame.padded_bytes_per_row as usize)
        .flat_map(|row| {
            row[0..(frame.width * 4) as usize]
                .chunks(4)
                .flat_map(|chunk| [chunk[0], chunk[1], chunk[2]]) // Skip alpha channel
        })
        .collect();

    let rgb_img =
        ImageBuffer::<image::Rgb<u8>, Vec<u8>>::from_raw(frame.width, frame.height, rgb_data)
            .context("Failed to create image from frame data")?;

    rgb_img
        .save_with_format(output_path, ImageFormat::Jpeg)
        .context("Failed to save JPEG")?;
    Ok(())
}

fn save_as_raw(frame: &RenderedFrame, output_path: &PathBuf) -> Result<()> {
    // Save raw RGBA data
    std::fs::write(output_path, &*frame.data).context("Failed to save raw frame data")?;
    Ok(())
}
