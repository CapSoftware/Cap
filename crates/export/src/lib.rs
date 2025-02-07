use cap_editor::Segment;
use cap_media::{
    data::{cast_f32_slice_to_bytes, AudioInfo, RawVideoFormat, VideoInfo},
    encoders::{H264Encoder, MP4File, MP4Input, OpusEncoder},
    feeds::{AudioData, AudioFrameBuffer},
    MediaError,
};
use cap_project::{ProjectConfiguration, RecordingMeta, XY};
use cap_rendering::{
    ProjectUniforms, RecordingSegmentDecoders, RenderSegment, RenderVideoConstants, RenderedFrame,
    SegmentVideoPaths, ProjectRecordings,
};
use futures::FutureExt;
use gifski::{self, Settings, progress::NoProgress, Collector};
use image::{ImageBuffer, Rgba};
use imgref::Img;
use rgb::RGBA8;
use std::{fs::File, path::PathBuf, sync::Arc, time::Duration};
use rayon::prelude::*;

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

    #[error("Other:{0}")]
    Other(String),

    #[error("Exporting timed out")]
    Timeout(#[from] tokio::time::error::Elapsed),
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
    TOnProgress: Fn(u32) + Send + Clone + 'static,
{
    pub async fn new(
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

        let mut render_segments = vec![];
        let mut audio_segments = vec![];

        for (i, s) in segments.iter().enumerate() {
            let segment_paths = match &meta.content {
                cap_project::Content::SingleSegment { segment: s } => SegmentVideoPaths {
                    display: meta.path(&s.display.path),
                    camera: s.camera.as_ref().map(|c| meta.path(&c.path)),
                },
                cap_project::Content::MultipleSegments { inner } => {
                    let s = &inner.segments[i];

                    SegmentVideoPaths {
                        display: meta.path(&s.display.path),
                        camera: s.camera.as_ref().map(|c| meta.path(&c.path)),
                    }
                }
            };
            render_segments.push(RenderSegment {
                cursor: s.cursor.clone(),
                decoders: RecordingSegmentDecoders::new(&meta, segment_paths)
                    .await
                    .map_err(ExportError::Other)?,
            });
            audio_segments.push(s.audio.clone());
        }

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
        match self.project.export.format {
            cap_project::ExportFormat::Mp4 => self.export_mp4().await,
            cap_project::ExportFormat::Gif => self.export_gif().await,
        }
    }

    async fn export_mp4(self) -> Result<PathBuf, ExportError> {
        struct AudioRender {
            buffer: AudioFrameBuffer,
        }

        println!("Exporting with custom muxer");

        let (tx_image_data, mut rx_image_data) =
            tokio::sync::mpsc::channel::<(RenderedFrame, u32)>(4);
        let (frame_tx, frame_rx) = std::sync::mpsc::sync_channel::<MP4Input>(4);

        let fps = self.fps;

        let audio_info = match self
            .audio_segments
            .get(0)
            .and_then(|d| d.as_ref().as_ref())
            .filter(|_| !self.project.audio.mute)
        {
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
            let mut info = VideoInfo::from_raw(
                RawVideoFormat::Rgba,
                self.output_size.0,
                self.output_size.1,
                self.fps,
            );
            info.time_base = ffmpeg::Rational::new(1, self.fps as i32);

            let mut encoder = cap_media::encoders::MP4File::init(
                "output",
                self.output_path.clone(),
                H264Encoder::factory("output_video", info),
                move |o| audio_info.map(|a| OpusEncoder::init("output_audio", a, o)),
            )
            .unwrap();

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
                let mut audio = if let Some(_) = self
                    .audio_segments
                    .get(0)
                    .and_then(|d| d.as_ref().as_ref())
                    .filter(|_| !self.project.audio.mute)
                {
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

                loop {
                    let Some((frame, frame_number)) =
                        tokio::time::timeout(Duration::from_secs(3), rx_image_data.recv()).await?
                    else {
                        break;
                    };

                    (self.on_progress)(frame_count);

                    if frame_count == 0 {
                        first_frame = Some(frame.clone());
                    }

                    let audio_frame = if let Some(audio) = &mut audio {
                        if frame_count == 0 {
                            audio.buffer.set_playhead(0., &project);
                        }

                        let audio_info = audio.buffer.info();
                        let estimated_samples_per_frame =
                            f64::from(audio_info.sample_rate) / f64::from(self.fps);
                        let samples = estimated_samples_per_frame.ceil() as usize;

                        if let Some((_, frame_data)) =
                            audio.buffer.next_frame_data(samples, &project)
                        {
                            let mut frame = audio_info
                                .wrap_frame(unsafe { cast_f32_slice_to_bytes(&frame_data) }, 0);
                            let pts = (frame_number as f64 * f64::from(audio_info.sample_rate)
                                / f64::from(fps)) as i64;
                            frame.set_pts(Some(pts));
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
                        self.fps,
                    )
                    .wrap_frame(
                        &frame.data,
                        0,
                        frame.padded_bytes_per_row as usize,
                    );
                    video_frame.set_pts(Some(frame_number as i64));

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

    async fn export_gif(self) -> Result<PathBuf, ExportError> {
        println!("Exporting as GIF");

        let (tx_image_data, mut rx_image_data) =
            tokio::sync::mpsc::channel::<(RenderedFrame, u32)>(4);

        let quality = match self.project.export.gif_quality {
            cap_project::GifQuality::Standard => 50,
            cap_project::GifQuality::High => 100,
        };

        let settings = Settings {
            width: Some(self.output_size.0),
            height: Some(self.output_size.1),
            quality,
            repeat: gifski::Repeat::Infinite,
            fast: true,
        };

        let output_path = self.output_path.clone();
        let fps = self.fps;

        // Calculate total frames based on duration and fps
        let recordings = ProjectRecordings::new(&self.meta);
        let duration = get_duration(&recordings, &self.meta, &self.project);
        let total_frames = (self.fps as f64 * duration).ceil() as u32;
        
        println!(
            "Final export duration: {} seconds ({} frames at {}fps)",
            duration, total_frames, self.fps
        );

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
        .then(|f| async { f.map_err(Into::<ExportError>::into) });

        let output_path_clone = output_path.clone();
        let on_progress = self.on_progress;
        
        // Create a channel for collecting frames
        let (frame_tx, frame_rx) = std::sync::mpsc::sync_channel(32); // Increased buffer for better throughput
        
        // Clone on_progress for the receive task
        let on_progress_receive = on_progress.clone();
        
        // Spawn a task to receive frames and collect them
        let receive_task = tokio::spawn(async move {
            let mut frames = Vec::with_capacity(total_frames as usize);
            while let Some((frame, frame_number)) = rx_image_data.recv().await {
                frames.push((frame, frame_number));
                // Frame collection phase: 0 to total_frames
                on_progress_receive(frame_number + 1);
            }
            // Send all collected frames through the sync channel
            frame_tx.send(frames).map_err(|e| {
                ExportError::Other(format!("Failed to send frames: {}", e))
            })?;
            Ok::<_, ExportError>(())
        });

        let encoder_thread = tokio::task::spawn_blocking(move || {
            let (collector, writer) = gifski::new(settings)
                .map_err(|e| ExportError::Other(e.to_string()))?;

            let writer_handle = std::thread::spawn(move || {
                println!("Starting to write final GIF file to disk...");
                writer.write(
                    File::create(&output_path_clone).map_err(ExportError::IO)?,
                    &mut NoProgress{},
                )
                .map_err(|e| ExportError::Other(e.to_string()))
            });

            // Receive all frames at once
            let frames = frame_rx.recv().map_err(|e| 
                ExportError::Other(format!("Failed to receive frames: {}", e)))?;

            println!("Processing {} frames in parallel", frames.len());

            // Process frames in parallel using rayon
            let chunk_size = frames.len() / 10;  // Split into 10 chunks for progress
            let chunks = frames.par_chunks(chunk_size.max(1));
            
            // Process all chunks first
            chunks.enumerate().try_for_each(|(chunk_idx, chunk)| {
                chunk.iter().try_for_each(|(frame, frame_number)| {
                    let rgba_pixels: Vec<RGBA8> = frame.data
                        .chunks_exact(4)
                        .map(|chunk| RGBA8::new(chunk[0], chunk[1], chunk[2], chunk[3]))
                        .collect();
                    
                    let pixels = Img::new(
                        rgba_pixels,
                        frame.width as usize,
                        frame.height as usize,
                    );
                    
                    let timestamp = *frame_number as f64 / fps as f64;
                    
                    collector.add_frame_rgba(
                        *frame_number as usize,
                        pixels,
                        timestamp,
                    ).map_err(|e| ExportError::Other(e.to_string()))
                })?;
                
                Ok::<_, ExportError>(())
            })?;

            // Update progress after each chunk is complete
            for i in 0..10 {
                on_progress(total_frames + 1 + i);
            }

            println!("Completed parallel GIF encoding of {} frames", frames.len());
            
            // GIF assembly phase: total_frames + 11
            on_progress(total_frames + 11);
            println!("Starting final GIF assembly and optimization...");
            
            drop(collector);
            
            // Writing to disk phase: total_frames + 12
            on_progress(total_frames + 12);
            println!("Writing optimized GIF to disk (this may take a moment)...");
            
            let result = writer_handle.join()
                .map_err(|_| ExportError::Other("GIF writer thread panicked".into()))?;
                
            // Complete phase: total_frames + 13
            on_progress(total_frames + 13);
            println!("GIF file has been successfully written to disk");
            result
        });

        // Wait for all tasks to complete
        let (video_result, receive_result, encoder_result) = 
            tokio::join!(render_video_task, receive_task, encoder_thread);
        
        video_result?;
        receive_result?;
        encoder_result?;

        Ok(output_path)
    }
}

fn get_duration(
    recordings: &ProjectRecordings,
    meta: &RecordingMeta,
    project: &ProjectConfiguration,
) -> f64 {
    // If there's a timeline, use its duration
    if let Some(timeline) = &project.timeline {
        let timeline_duration = timeline.duration();
        println!("Using timeline duration: {}", timeline_duration);
        return timeline_duration;
    }

    // Otherwise fall back to the max duration of recordings
    let mut max_duration = recordings.duration();
    println!("Initial screen recording duration: {}", max_duration);

    // Check camera duration if it exists
    if let Some(camera_path) = meta.content.camera_path() {
        if let Ok(camera_duration) =
            recordings.get_source_duration(&camera_path.to_path(&meta.project_path))
        {
            println!("Camera recording duration: {}", camera_duration);
            max_duration = max_duration.max(camera_duration);
            println!("New max duration after camera check: {}", max_duration);
        }
    }

    max_duration
}
