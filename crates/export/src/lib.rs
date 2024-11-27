use cap_editor::Segment;
use image::{ImageBuffer, Rgba};
use mp4::Mp4Reader;
use std::{path::PathBuf, sync::Arc};

use cap_media::feeds::AudioFrameBuffer;
use cap_project::{ProjectConfiguration, RecordingMeta};
use cap_rendering::{
    ProjectUniforms, RecordingSegmentDecoders, RenderSegment, RenderVideoConstants,
    SegmentVideoPaths,
};

struct AudioRender {
    buffer: AudioFrameBuffer,
    pipe_tx: tokio::sync::mpsc::Sender<Vec<u8>>,
}

const FPS: u32 = 30;

#[derive(thiserror::Error, Debug)]
pub enum ExportError {
    #[error("FFmpeg: {0}")]
    FFmpeg(String),

    #[error("IO: {0}")]
    IO(#[from] std::io::Error),

    #[error("FFmpeg Task: {0}")]
    FFmpegTask(#[from] tokio::task::JoinError),

    #[error("Rendering: {0}")]
    Rendering(#[from] cap_rendering::RenderingError),
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
        .map(|(i, segment)| match &meta.content {
            cap_project::Content::SingleSegment { segment: s } => (
                RenderSegment {
                    cursor: segment.cursor.clone(),
                    decoders: RecordingSegmentDecoders::new(
                        &meta,
                        SegmentVideoPaths {
                            display: s.display.path.as_path(),
                            camera: s.camera.as_ref().map(|c| c.path.as_path()),
                        },
                    ),
                },
                segment.audio.clone(),
            ),
            cap_project::Content::MultipleSegments { inner } => {
                let s = &inner.segments[i];

                segment.cursor.clone();
                RecordingSegmentDecoders::new(
                    &meta,
                    SegmentVideoPaths {
                        display: s.display.path.as_path(),
                        camera: s.camera.as_ref().map(|c| c.path.as_path()),
                    },
                );
                segment.audio.clone();

                todo!()
            }
        })
        .unzip();

    let ffmpeg_handle = tokio::spawn({
        let project = project.clone();
        let project_path = project_path.clone();
        async move {
            println!("Starting FFmpeg output process...");
            let mut ffmpeg = cap_ffmpeg_cli::FFmpeg::new();

            let audio_dir = tempfile::tempdir().unwrap();
            let video_dir = tempfile::tempdir().unwrap();
            let mut audio = None::<AudioRender>;
            // if let Some(audio_data) = audio.as_ref() {
            //     let (tx, rx) = tokio::sync::mpsc::channel::<Vec<u8>>(30);

            //     let pipe_path =
            //         cap_utils::create_channel_named_pipe(rx, audio_dir.path().join("audio.pipe"));

            //     ffmpeg.add_input(cap_ffmpeg_cli::FFmpegRawAudioInput {
            //         input: pipe_path,
            //         sample_format: "f64le".to_string(),
            //         sample_rate: audio_data.info.sample_rate,
            //         channels: audio_data.info.channels as u16,
            //     });

            //     let buffer = AudioFrameBuffer::new(audio_data.clone());
            //     Some(AudioRender {
            //         buffer,
            //         pipe_tx: tx,
            //     })
            // } else {
            //     None
            // };

            let video_tx = {
                let (tx, rx) = tokio::sync::mpsc::channel::<Vec<u8>>(30);

                let pipe_path =
                    cap_utils::create_channel_named_pipe(rx, video_dir.path().join("video.pipe"));

                ffmpeg.add_input(cap_ffmpeg_cli::FFmpegRawVideoInput {
                    width: output_size.0,
                    height: output_size.1,
                    fps: 30,
                    pix_fmt: "rgba",
                    input: pipe_path,
                });

                tx
            };

            ffmpeg
                .command
                .args(["-f", "mp4"])
                .args(["-codec:v", "libx264", "-codec:a", "aac"])
                .args(["-preset", "ultrafast"])
                .args(["-pix_fmt", "yuv420p", "-tune", "zerolatency"])
                .arg("-y")
                .arg(&output_path);

            let mut ffmpeg_process = ffmpeg.start();

            let mut frame_count = 0;
            let mut first_frame = None;

            loop {
                tokio::select! {
                    result = ffmpeg_process.wait() => {
                        match result {
                            Err(e) => Err(ExportError::FFmpeg(e.to_string())),
                            Ok(status) => {
                                if status.success() {
                                    Ok(())
                                } else {
                                    Err(ExportError::FFmpeg(
                                        ffmpeg_process
                                            .read_stderr()
                                            .await
                                            .unwrap_or_else(|_| "Failed to read FFmpegg error".to_string())
                                    ))
                                }
                            }
                        }?;
                    }
                    frame = rx_image_data.recv()  => {
                        match frame {
                            Some(frame) => {
                                on_progress(frame_count);

                                if frame_count == 0 {
                                    first_frame = Some(frame.clone());
                                }

                                if let Some(audio) = &mut audio {
                                    if frame_count == 0 {
                                        audio.buffer.set_playhead(0., project.timeline());
                                    }

                                    let audio_info = audio.buffer.info();
                                    let estimated_samples_per_frame =
                                        f64::from(audio_info.sample_rate) / f64::from(FPS);
                                    let samples = estimated_samples_per_frame.ceil() as usize;

                                    if let Some((_, frame_data)) =
                                        audio.buffer.next_frame_data(samples, project.timeline())
                                    {
                                        let frame_samples = frame_data.to_vec();
                                        audio.pipe_tx.send(frame_samples).await.unwrap();
                                    }
                                }

                                video_tx.send(frame).await.unwrap();

                                frame_count += 1;
                            }
                            None => {
                                println!("All frames sent to FFmpeg");
                                break;
                            }
                        }
                    }
                }
            }

            ffmpeg_process.stop().await;

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

            Ok::<_, ExportError>(output_path)
        }
    });

    println!("Rendering video to channel");

    cap_rendering::render_video_to_channel(
        render_constants.options,
        project,
        tx_image_data,
        &meta,
        render_segments,
    )
    .await?;

    let output_path = ffmpeg_handle.await??;

    println!("Copying file to {:?}", project_path);
    let result_path = project_path.join("output").join("result.mp4");
    // Function to check if the file is a valid MP4
    fn is_valid_mp4(path: &std::path::Path) -> bool {
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

    if output_path != result_path {
        println!("Waiting for valid MP4 file at {:?}", output_path);
        // Wait for the file to become a valid MP4
        let mut attempts = 0;
        while attempts < 10 {
            // Wait for up to 60 seconds
            if is_valid_mp4(&output_path) {
                println!("Valid MP4 file detected after {} seconds", attempts);
                match std::fs::copy(&output_path, &result_path) {
                    Ok(bytes) => {
                        println!("Successfully copied {} bytes to {:?}", bytes, result_path)
                    }
                    Err(e) => eprintln!("Failed to copy file: {:?}", e),
                }
                break;
            }
            println!("Attempt {}: File not yet valid, waiting...", attempts + 1);
            std::thread::sleep(std::time::Duration::from_secs(1));
            attempts += 1;
        }

        if attempts == 10 {
            eprintln!("Timeout: Failed to detect a valid MP4 file after 60 seconds");
        }
    }

    Ok(output_path)
}
