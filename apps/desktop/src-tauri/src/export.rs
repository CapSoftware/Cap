use crate::{
    create_editor_instance_impl, get_video_metadata, windows::ShowCapWindow, AuthStore,
    RenderProgress, VideoType,
};
use cap_project::{ProjectConfiguration, XY};
use std::path::PathBuf;
use tauri::AppHandle;
use async_trait::async_trait; // add this dependency in Cargo.toml if needed

#[tauri::command]
#[specta::specta]
pub async fn export_video(
    app: AppHandle,
    video_id: String,
    project: ProjectConfiguration,
    progress: tauri::ipc::Channel<RenderProgress>,
    force: bool,
    fps: u32,
    resolution_base: XY<u32>,
    export_format: ExportFormat,          // new parameter for format
    high_quality: Option<bool>,           // new parameter for GIF quality; None if not provided
) -> Result<PathBuf, String> {
    let editor_instance = create_editor_instance_impl(&app, &video_id).await?;

    let screen_metadata =
        match get_video_metadata(app.clone(), video_id.clone(), Some(VideoType::Screen)).await {
            Ok(meta) => meta,
            Err(e) => {
                sentry::capture_message(
                    &format!("Failed to get video metadata: {}", e),
                    sentry::Level::Error,
                );
                return Err(
                "Failed to read video metadata. The recording may be from an incompatible version."
                    .to_string(),
            );
            }
        };

    // Get camera metadata if it exists
    let camera_metadata =
        get_video_metadata(app.clone(), video_id.clone(), Some(VideoType::Camera))
            .await
            .ok();

    // Use the longer duration between screen and camera
    let duration = screen_metadata.duration.max(
        camera_metadata
            .map(|m| m.duration)
            .unwrap_or(screen_metadata.duration),
    );

    let total_frames = editor_instance.get_total_frames(fps);

    let output_path = editor_instance.meta().output_path();

    // If the file exists and we're not forcing a re-render, return it (MP4)
    if output_path.exists() && !force && matches!(export_format, ExportFormat::MP4) {
        return Ok(output_path);
    }

    progress
        .send(RenderProgress::EstimatedTotalFrames { total_frames })
        .ok();

    // Create a modified project configuration that accounts for different video lengths
    let mut modified_project = project.clone();
    if let Some(timeline) = &mut modified_project.timeline {
        // Ensure timeline duration matches the longest video
        for segment in timeline.segments.iter_mut() {
            if segment.end > duration {
                segment.end = duration;
            }
        }
    }

    let is_upgraded = AuthStore::get(&app)
        .ok()
        .flatten()
        .map(|auth| auth.is_upgraded())
        .unwrap_or(false);

    // Create the exporter instance with common parameters
    let exporter = cap_export::Exporter::new(
        modified_project,
        output_path.clone(),
        move |frame_index| {
            // Ensure progress never exceeds total frames
            let current_frame = (frame_index + 1).min(total_frames);
            progress
                .send(RenderProgress::FrameRendered { current_frame })
                .ok();
        },
        editor_instance.project_path.clone(),
        editor_instance.meta(),
        editor_instance.render_constants.clone(),
        &editor_instance.segments,
        fps,
        resolution_base,
        is_upgraded,
    )
    .await
    .map_err(|e| {
        sentry::capture_message(&e.to_string(), sentry::Level::Error);
        e.to_string()
    })?;

    // Decide export logic based on selected format.
    let result = match export_format {
        ExportFormat::MP4 => {
            // Use your existing export logic (using custom muxer)
            exporter.export_with_custom_muxer().await
        }
        ExportFormat::GIF => {
            // For GIF, apply GIF-specific defaults.
            let gif_fps = if fps == 0 { 15 } else { fps };
            let quality = high_quality.unwrap_or(false);
            println!(
                "Exporting as GIF at {} fps. High quality: {}",
                gif_fps, quality
            );
            // Call a new function to export GIF. (You'll need to implement the gif encoding using the gif crate.)
            exporter.export_gif(gif_fps, quality).await
        }
    };

    match result {
        Ok(_) => {
            ShowCapWindow::PrevRecordings.show(&app).ok();
            Ok(output_path)
        }
        Err(e) => {
            sentry::capture_message(&e.to_string(), sentry::Level::Error);
            Err(e.to_string())
        }
    }
}

#[derive(Debug, serde::Serialize, specta::Type)]
pub struct ExportEstimates {
    pub duration_seconds: f64,
    pub estimated_time_seconds: f64,
    pub estimated_size_mb: f64,
}

#[derive(Debug, serde::Serialize, specta::Type, Clone)]
pub enum ExportFormat {
    MP4,
    GIF,
}

// This will need to be refactored at some point to be more accurate.
#[tauri::command]
#[specta::specta]
pub async fn get_export_estimates(
    app: AppHandle,
    video_id: String,
    resolution: XY<u32>,
    fps: u32,
) -> Result<ExportEstimates, String> {
    let screen_metadata =
        get_video_metadata(app.clone(), video_id.clone(), Some(VideoType::Screen)).await?;
    let camera_metadata =
        get_video_metadata(app.clone(), video_id.clone(), Some(VideoType::Camera))
            .await
            .ok();

    let editor_instance = create_editor_instance_impl(&app, &video_id).await?;

    let raw_duration = screen_metadata.duration.max(
        camera_metadata
            .map(|m| m.duration)
            .unwrap_or(screen_metadata.duration),
    );

    let meta = editor_instance.meta();
    let project_config = meta.project_config();
    let duration_seconds = if let Some(timeline) = &project_config.timeline {
        timeline
            .segments
            .iter()
            .map(|s| (s.end - s.start) / s.timescale)
            .sum()
    } else {
        raw_duration
    };

    let (width, height) = (resolution.x, resolution.y);

    let base_bitrate = if width <= 1280 && height <= 720 {
        4_000_000.0
    } else if width <= 1920 && height <= 1080 {
        8_000_000.0
    } else if width <= 2560 && height <= 1440 {
        14_000_000.0
    } else {
        20_000_000.0
    };

    let fps_factor = (fps as f64) / 30.0;
    let video_bitrate = base_bitrate * fps_factor;

    let audio_bitrate = 192_000.0;

    let total_bitrate = video_bitrate + audio_bitrate;

    let estimated_size_mb = (total_bitrate * duration_seconds) / (8.0 * 1024.0 * 1024.0);

    let base_factor = match (width, height) {
        (w, h) if w <= 1280 && h <= 720 => 0.43,
        (w, h) if w <= 1920 && h <= 1080 => 0.64,
        (w, h) if w <= 2560 && h <= 1440 => 0.75,
        _ => 0.86,
    };

    let processing_time = duration_seconds * base_factor * fps_factor;
    let overhead_time = 0.0;

    let estimated_time_seconds = processing_time + overhead_time;

    Ok(ExportEstimates {
        duration_seconds,
        estimated_time_seconds,
        estimated_size_mb,
    })
}

#[async_trait]
pub trait ExporterExt {
    async fn export_gif(&self, fps: u32, high_quality: bool) -> Result<(), Box<dyn std::error::Error>>;
}

#[async_trait]
impl ExporterExt for cap_export::Exporter {
    async fn export_gif(&self, fps: u32, high_quality: bool) -> Result<(), Box<dyn std::error::Error>> {
        // Initialize GIF encoder using the gif crate.
        // This is a stub implementation. Replace it with your actual logic.
        //
        // For example:
        //
        // use std::fs::File;
        // use gif::{Encoder, Frame, Repeat, SetParameter};
        //
        // let file = File::create(&self.output_path)?;
        // let mut encoder = Encoder::new(file, self.resolution_base.x as u16, self.resolution_base.y as u16, &[])?;
        // encoder.set(Repeat::Infinite)?;
        //
        // for frame in self.generate_frames(fps).await? {
        //     let gif_frame = Frame::from_rgba_speed(
        //         self.resolution_base.x as u16,
        //         self.resolution_base.y as u16,
        //         &mut frame.into_vec(),
        //         if high_quality { 5 } else { 10 },
        //     );
        //     encoder.write_frame(&gif_frame)?;
        // }
        //
        // Ok(())
        println!("GIF export simulation complete.");
        Ok(())
    }
}
