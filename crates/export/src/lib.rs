use cap_editor::Segment;
use cap_media::{
    data::{cast_f32_slice_to_bytes, AudioInfo, RawVideoFormat, VideoInfo},
    encoders::{MP4Encoder, MP4Input},
    feeds::{AudioData, AudioFrameBuffer},
    MediaError,
};
use cap_project::{ProjectConfiguration, RecordingMeta, XY};
use cap_rendering::{
    ProjectUniforms, RecordingSegmentDecoders, RenderSegment, RenderVideoConstants, RenderedFrame,
    SegmentVideoPaths,
};
use futures::FutureExt;
use image::{ImageBuffer, Rgba};
use std::{path::PathBuf, sync::Arc};

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
    fps: u32,
    resolution_base: XY<u32>,
    is_upgraded: bool,
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
        fps: u32,
        resolution_base: XY<u32>,
        is_upgraded: bool,
    ) -> Result<Self, ExportError> {
        let output_folder = output_path.parent().unwrap();
        std::fs::create_dir_all(output_folder)?;

        let output_size =
            ProjectUniforms::get_output_size(&render_constants.options, &project, resolution_base);

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
            fps,
            resolution_base,
            is_upgraded,
        })
    }

    pub async fn export_with_custom_muxer(self) -> Result<PathBuf, ExportError> {
        struct AudioRender {
            buffer: AudioFrameBuffer,
        }

        println!("Exporting with custom muxer");

        let (tx_image_data, mut rx_image_data) = tokio::sync::mpsc::channel::<RenderedFrame>(4);
        let (frame_tx, frame_rx) = std::sync::mpsc::sync_channel::<MP4Input>(4);

        let fps = self.fps;

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
                    self.fps,
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
                        let estimated_samples_per_frame =
                            f64::from(audio_info.sample_rate) / f64::from(self.fps);
                        let samples = estimated_samples_per_frame.ceil() as usize;

                        if let Some((_, frame_data)) = audio
                            .buffer
                            .next_frame_data(samples, project.timeline.as_ref().map(|t| t))
                        {
                            let mut frame = audio_info
                                .wrap_frame(unsafe { cast_f32_slice_to_bytes(&frame_data) }, 0);
                            let pts = (frame_count as f64 * f64::from(audio_info.sample_rate)
                                / f64::from(fps)) as i64;
                            frame.set_pts(Some(pts));
                            // println!(
                            //     "Export: Sending audio frame {} with PTS: {:?}, samples: {}, data size: {}",
                            //     frame_count,
                            //     frame.pts(),
                            //     samples,
                            //     frame_data.len()
                            // );
                            Some(frame)
                        } else {
                            None
                        }
                    } else {
                        None
                    };

                    // println!(
                    //     "Export: Processing frame {} (size: {}x{}, padded_bytes_per_row: {})",
                    //     frame_count, frame.width, frame.height, frame.padded_bytes_per_row
                    // );

                    let mut video_frame = VideoInfo::from_raw(
                        RawVideoFormat::Rgba,
                        self.output_size.0,
                        self.output_size.1,
                        self.fps,
                    )
                    .wrap_frame(
                        &frame.data,
                        0,
                        frame.padded_bytes_per_row as usize,
                    );
                    video_frame.set_pts(Some(frame_count as i64));

                    // println!(
                    //     "Export: Sending frame {} to encoder (PTS: {:?})",
                    //     frame_count,
                    //     video_frame.pts()
                    // );

                    frame_tx
                        .send(MP4Input {
                            audio: audio_frame,
                            video: video_frame,
                        })
                        .ok();

                    frame_count += 1;
                }

                // Save the first frame as a screenshot and thumbnail
                if let Some(frame) = first_frame {
                    let rgb_img = ImageBuffer::<image::Rgb<u8>, Vec<u8>>::from_raw(
                        frame.width,
                        frame.height,
                        frame
                            .data
                            .chunks(frame.padded_bytes_per_row as usize)
                            .flat_map(|row| {
                                row[0..(frame.width * 4) as usize]
                                    .chunks(4)
                                    .flat_map(|chunk| [chunk[0], chunk[1], chunk[2]])
                            })
                            .collect::<Vec<_>>(),
                    )
                    .expect("Failed to create image from frame data");

                    let screenshots_dir = project_path.join("screenshots");
                    std::fs::create_dir_all(&screenshots_dir).unwrap_or_else(|e| {
                        eprintln!("Failed to create screenshots directory: {:?}", e);
                    });

                    // Save full-size screenshot
                    let screenshot_path = screenshots_dir.join("display.jpg");
                    rgb_img.save(&screenshot_path).unwrap_or_else(|e| {
                        eprintln!("Failed to save screenshot: {:?}", e);
                    });
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
            self.fps,
            self.resolution_base,
            self.is_upgraded,
        )
        .then(|f| async { f.map_err(Into::into) });

        let (output_path, _, _) = tokio::try_join!(encoder_thread, render_video_task, render_task)?;

        Ok(output_path)
    }
}
