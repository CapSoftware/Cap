use cap_editor::Segment;
use cap_media::data::{AudioInfo, RawVideoFormat, VideoInfo};
use cap_media::encoders::{MP4Encoder, MP4Input};
use cap_media::MediaError;
use futures::FutureExt;
use image::{ImageBuffer, Rgba};
use mp4::Mp4Reader;
use std::path::Path;
use std::{path::PathBuf, sync::Arc};
use tokio::sync::oneshot;

use cap_media::feeds::AudioFrameBuffer;
use cap_project::{ProjectConfiguration, RecordingMeta};
use cap_rendering::{
    ProjectUniforms, RecordingSegmentDecoders, RenderSegment, RenderVideoConstants,
    SegmentVideoPaths,
};

struct AudioRender {
    buffer: AudioFrameBuffer,
}

const FPS: u32 = 30;

#[derive(thiserror::Error, Debug)]
pub enum ExportError {
    #[error("FFmpeg: {0}")]
    FFmpeg(String),

    #[error("IO: {0}")]
    IO(#[from] std::io::Error),

    #[error("Rendering: {0}")]
    Rendering(#[from] cap_rendering::RenderingError),

    #[error("Media/{0}")]
    Media(#[from] cap_media::MediaError),

    #[error("Join: {0}")]
    Join(#[from] tokio::task::JoinError),
}

pub async fn export_video_to_file(
    project: ProjectConfiguration,
    output_path: PathBuf,
    on_progress: impl Fn(u32) + Send + 'static,
    project_path: &PathBuf,
    meta: RecordingMeta,
    render_constants: Arc<RenderVideoConstants>,
    segments: &[Segment],
) -> Result<PathBuf, ExportError> {
    let (tx_image_data, mut rx_image_data) = tokio::sync::mpsc::channel::<Vec<u8>>(4);

    let output_folder = output_path.parent().unwrap();
    std::fs::create_dir_all(output_folder)?;

    let output_size = ProjectUniforms::get_output_size(&render_constants.options, &project);

    let (render_segments, audio_segments): (Vec<_>, Vec<_>) = segments
        .iter()
        .enumerate()
        .map(|(i, segment)| {
            let segment_paths = match &meta.content {
                cap_project::Content::SingleSegment { segment: s } => SegmentVideoPaths {
                    display: s.display.path.as_path(),
                    camera: s.camera.as_ref().map(|c| c.path.as_path()),
                },
                cap_project::Content::MultipleSegments { inner } => {
                    let s = &inner.segments[i];

                    SegmentVideoPaths {
                        display: s.display.path.as_path(),
                        camera: s.camera.as_ref().map(|c| c.path.as_path()),
                    }
                }
            };

            (
                RenderSegment {
                    cursor: segment.cursor.clone(),
                    decoders: RecordingSegmentDecoders::new(&meta, segment_paths),
                },
                segment.audio.clone(),
            )
        })
        .unzip();

    let (frame_tx, frame_rx) = std::sync::mpsc::sync_channel::<MP4Input>(4);

    let audio_info = match audio_segments.get(0).and_then(|d| d.as_ref().as_ref()) {
        Some(audio_data) => Some(
            AudioInfo::new(
                audio_data.info.sample_format,
                audio_data.info.sample_rate,
                audio_data.info.channels as u16,
            )
            .map_err(Into::<MediaError>::into)?,
        ),
        _ => None,
    };

    let encoder_thread = tokio::task::spawn_blocking(move || {
        let mut encoder = cap_media::encoders::MP4Encoder::init(
            "output",
            VideoInfo::from_raw(MP4Encoder::video_format(), output_size.0, output_size.1, 30),
            audio_info,
            cap_media::encoders::Output::File(output_path.clone()),
        )?;

        while let Ok(frame) = frame_rx.recv() {
            encoder.queue_video_frame(frame.video);
            if let Some(audio) = frame.audio {
                encoder.queue_audio_frame(audio);
            }
        }

        encoder.finish();

        Ok::<_, ExportError>(output_path)
    })
    .then(|f| async { f.map_err(Into::into).and_then(|v| v) });

    let render_task = tokio::spawn({
        let project = project.clone();
        let project_path = project_path.clone();
        async move {
            println!("Starting FFmpeg output process...");
            let mut audio = if let Some(_) = audio_segments.get(0).and_then(|d| d.as_ref().as_ref())
            {
                Some(AudioRender {
                    buffer: AudioFrameBuffer::new(
                        audio_segments
                            .iter()
                            .map(|s| s.as_ref().as_ref().unwrap().clone())
                            .collect(),
                    ),
                })
            } else {
                None
            };

            let mut frame_count = 0;
            let mut first_frame = None;

            while let Some(frame) = rx_image_data.recv().await {
                on_progress(frame_count);

                if frame_count == 0 {
                    first_frame = Some(frame.clone());
                }

                let audio_frame = if let Some(audio) = &mut audio {
                    if frame_count == 0 {
                        audio.buffer.set_playhead(0., project.timeline());
                    }

                    let audio_info = audio.buffer.info();
                    // dbg!(&audio_info);
                    let estimated_samples_per_frame =
                        f64::from(audio_info.sample_rate) / f64::from(FPS);
                    let samples = estimated_samples_per_frame.ceil() as usize;

                    if let Some((_, frame_data)) =
                        audio.buffer.next_frame_data(samples, project.timeline())
                    {
                        // dbg!(&audio_info);
                        let mut frame = audio_info.wrap_frame(
                            &frame_data
                                .to_vec()
                                .chunks(8)
                                .flat_map(|v| {
                                    (f64::from_le_bytes([
                                        v[0], v[1], v[2], v[3], v[4], v[5], v[6], v[7],
                                    ]) as f32)
                                        .to_le_bytes()
                                })
                                .collect::<Vec<_>>(),
                            0,
                        );
                        frame.set_pts(Some(1_000_000 / 30 * (frame_count as i64)));
                        Some(frame)
                    } else {
                        None
                    }
                } else {
                    None
                };

                let mut video_frame =
                    VideoInfo::from_raw(RawVideoFormat::Rgba, output_size.0, output_size.1, 30)
                        .wrap_frame(&frame, 0);
                video_frame.set_pts(Some(frame_count as i64));

                frame_tx
                    .send(MP4Input {
                        audio: audio_frame,
                        video: video_frame,
                    })
                    .ok();

                frame_count += 1;
            }

            // Save the first frame as a screenshot and thumbnail
            if let Some(frame_data) = first_frame {
                let width = output_size.0;
                let height = output_size.1;
                let rgba_img: ImageBuffer<Rgba<u8>, Vec<u8>> =
                    ImageBuffer::from_raw(width, height, frame_data)
                        .expect("Failed to create image from frame data");

                // Convert RGBA to RGB
                let rgb_img: ImageBuffer<image::Rgb<u8>, Vec<u8>> =
                    ImageBuffer::from_fn(width, height, |x, y| {
                        let rgba = rgba_img.get_pixel(x, y);
                        image::Rgb([rgba[0], rgba[1], rgba[2]])
                    });

                let screenshots_dir = project_path.join("screenshots");
                std::fs::create_dir_all(&screenshots_dir).unwrap_or_else(|e| {
                    eprintln!("Failed to create screenshots directory: {:?}", e);
                });

                // Save full-size screenshot
                let screenshot_path = screenshots_dir.join("display.jpg");
                rgb_img.save(&screenshot_path).unwrap_or_else(|e| {
                    eprintln!("Failed to save screenshot: {:?}", e);
                });

                // // Create and save thumbnail
                // let thumbnail = image::imageops::resize(
                //     &rgb_img,
                //     100,
                //     100,
                //     image::imageops::FilterType::Lanczos3,
                // );
                // let thumbnail_path = screenshots_dir.join("thumbnail.png");
                // thumbnail.save(&thumbnail_path).unwrap_or_else(|e| {
                //     eprintln!("Failed to save thumbnail: {:?}", e);
                // });
            } else {
                eprintln!("No frames were processed, cannot save screenshot or thumbnail");
            }

            Ok::<_, ExportError>(())
        }
    })
    .then(|f| async { f.map_err(Into::into).and_then(|v| v) });

    println!("Rendering video to channel");

    let render_video_task = cap_rendering::render_video_to_channel(
        render_constants.options,
        project,
        tx_image_data,
        &meta,
        render_segments,
    )
    .then(|f| async { f.map_err(Into::into) });

    let (output_path, _, _) = tokio::try_join!(encoder_thread, render_video_task, render_task)?;

    Ok(output_path)
}

/// Validates if a file at the given path is a valid MP4 file
pub fn is_valid_mp4(path: &Path) -> bool {
    if let Ok(file) = std::fs::File::open(path) {
        let file_size = match file.metadata() {
            Ok(metadata) => metadata.len(),
            Err(_) => return false,
        };
        let reader = std::io::BufReader::new(file);
        Mp4Reader::read_header(reader, file_size).is_ok()
    } else {
        false
    }
}
