use cap_editor::Segment;
use cap_media::{
    data::{AudioInfo, RawVideoFormat, VideoInfo},
    encoders::{MP4Encoder, MP4Input},
    feeds::{AudioData, AudioFrameBuffer},
    MediaError,
};
use cap_project::{ProjectConfiguration, RecordingMeta};
use cap_rendering::{
    ProjectUniforms, RecordingSegmentDecoders, RenderSegment, RenderVideoConstants,
    SegmentVideoPaths,
};
use futures::FutureExt;
use image::{ImageBuffer, Rgba};
use std::{path::PathBuf, sync::Arc};

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

pub struct Exporter<TOnProgress> {
    render_segments: Vec<RenderSegment>,
    audio_segments: Vec<Arc<Option<AudioData>>>,
    output_size: (u32, u32),
    output_path: PathBuf,
    project: ProjectConfiguration,
    project_path: PathBuf,
    on_progress: TOnProgress,
    meta: RecordingMeta,
    render_constants: Arc<RenderVideoConstants>,
}

impl<TOnProgress> Exporter<TOnProgress>
where
    TOnProgress: Fn(u32) + Send + 'static,
{
    pub fn new(
        project: ProjectConfiguration,
        output_path: PathBuf,
        on_progress: TOnProgress,
        project_path: PathBuf,
        meta: RecordingMeta,
        render_constants: Arc<RenderVideoConstants>,
        segments: &[Segment],
    ) -> Result<Self, ExportError> {
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

        Ok(Self {
            project,
            output_path,
            on_progress,
            project_path,
            meta,
            render_constants,
            render_segments,
            audio_segments,
            output_size,
        })
    }

    pub async fn export_with_custom_muxer(self) -> Result<PathBuf, ExportError> {
        struct AudioRender {
            buffer: AudioFrameBuffer,
        }

        let (tx_image_data, mut rx_image_data) = tokio::sync::mpsc::channel::<Vec<u8>>(4);

        let (frame_tx, frame_rx) = std::sync::mpsc::sync_channel::<MP4Input>(4);

        let audio_info = match self.audio_segments.get(0).and_then(|d| d.as_ref().as_ref()) {
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
                VideoInfo::from_raw(
                    MP4Encoder::video_format(),
                    self.output_size.0,
                    self.output_size.1,
                    30,
                ),
                audio_info,
                cap_media::encoders::Output::File(self.output_path.clone()),
            )?;

            while let Ok(frame) = frame_rx.recv() {
                encoder.queue_video_frame(frame.video);
                if let Some(audio) = frame.audio {
                    encoder.queue_audio_frame(audio);
                }
            }

            encoder.finish();

            Ok::<_, ExportError>(self.output_path)
        })
        .then(|f| async { f.map_err(Into::into).and_then(|v| v) });

        let render_task = tokio::spawn({
            let project = self.project.clone();
            let project_path = self.project_path.clone();
            async move {
                println!("Starting FFmpeg output process...");
                let mut audio =
                    if let Some(_) = self.audio_segments.get(0).and_then(|d| d.as_ref().as_ref()) {
                        Some(AudioRender {
                            buffer: AudioFrameBuffer::new(
                                self.audio_segments
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
                    (self.on_progress)(frame_count);

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

                    let mut video_frame = VideoInfo::from_raw(
                        RawVideoFormat::Rgba,
                        self.output_size.0,
                        self.output_size.1,
                        30,
                    )
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
                    let width = self.output_size.0;
                    let height = self.output_size.1;
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
            self.render_constants.options,
            self.project,
            tx_image_data,
            &self.meta,
            self.render_segments,
        )
        .then(|f| async { f.map_err(Into::into) });

        let (output_path, _, _) = tokio::try_join!(encoder_thread, render_video_task, render_task)?;

        Ok(output_path)
    }

    pub async fn export_with_ffmpeg_cli(self) -> Result<PathBuf, ExportError> {
        struct AudioRender {
            buffer: AudioFrameBuffer,
            pipe_tx: tokio::sync::mpsc::Sender<Vec<u8>>,
        }

        let (tx_image_data, mut rx_image_data) = tokio::sync::mpsc::channel::<Vec<u8>>(4);

        let ffmpeg_handle = tokio::spawn({
            let project = self.project.clone();
            let project_path = self.project_path.clone();
            async move {
                println!("Starting FFmpeg output process...");
                let mut ffmpeg = cap_ffmpeg_cli::FFmpeg::new();

                let audio_dir = tempfile::tempdir().unwrap();
                let video_dir = tempfile::tempdir().unwrap();
                let mut audio = if let Some(audio_data) =
                    self.audio_segments.get(0).and_then(|d| d.as_ref().as_ref())
                {
                    let (tx, rx) = tokio::sync::mpsc::channel::<Vec<u8>>(30);

                    let pipe_path = cap_utils::create_channel_named_pipe(
                        rx,
                        audio_dir.path().join("audio.pipe"),
                    );

                    ffmpeg.add_input(cap_ffmpeg_cli::FFmpegRawAudioInput {
                        input: pipe_path,
                        sample_format: "f64le".to_string(),
                        sample_rate: audio_data.info.sample_rate,
                        channels: audio_data.info.channels as u16,
                    });

                    Some(AudioRender {
                        buffer: AudioFrameBuffer::new(
                            self.audio_segments
                                .iter()
                                .map(|s| s.as_ref().as_ref().unwrap().clone())
                                .collect(),
                        ),
                        pipe_tx: tx,
                    })
                } else {
                    None
                };

                let video_tx = {
                    let (tx, rx) = tokio::sync::mpsc::channel::<Vec<u8>>(30);

                    let pipe_path = cap_utils::create_channel_named_pipe(
                        rx,
                        video_dir.path().join("video.pipe"),
                    );

                    ffmpeg.add_input(cap_ffmpeg_cli::FFmpegRawVideoInput {
                        width: self.output_size.0,
                        height: self.output_size.1,
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
                    .arg(&self.output_path);

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
                                    (self.on_progress)(frame_count);

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
                    let width = self.output_size.0;
                    let height = self.output_size.1;
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

                Ok::<_, ExportError>(self.output_path)
            }
        });

        println!("Rendering video to channel");

        cap_rendering::render_video_to_channel(
            self.render_constants.options,
            self.project,
            tx_image_data,
            &self.meta,
            self.render_segments,
        )
        .await?;

        let output_path = ffmpeg_handle.await??;

        Ok(output_path)
    }
}
