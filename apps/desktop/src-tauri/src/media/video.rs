use image::codecs::jpeg::JpegEncoder;
use image::{ImageBuffer, Rgba};
use scap::{
    capturer::{Capturer, Options, Resolution},
    frame::{Frame, FrameType},
};
use std::{
    future::Future,
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};
use tokio::sync::mpsc::error::TrySendError;
use tokio::{fs::File, io::AsyncWriteExt, sync::mpsc};

use super::{Instant, RecordingOptions, SharedFlag, SharedInstant};
use crate::app::config;
use crate::upload::{upload_recording_asset, RecordingAssetType};

pub struct VideoCapturer {
    capturer: Option<Capturer>,
    should_stop: SharedFlag,
    pub frame_width: u32,
    pub frame_height: u32,
    frame_receiver: Option<mpsc::Receiver<Arc<Vec<u8>>>>,
}

impl VideoCapturer {
    pub const FPS: u32 = 30;

    pub fn new(_width: usize, _height: usize, resolution: Resolution, should_stop: SharedFlag) -> VideoCapturer {
        let mut capturer = Capturer::new(Options {
            fps: Self::FPS,
            target: None,
            show_cursor: true,
            show_highlight: true,
            excluded_targets: None,
            output_type: FrameType::BGRAFrame,
            output_resolution: resolution,
            crop_area: None,
        });

        let [frame_width, frame_height] = capturer.get_output_frame_size();

        Self {
            capturer: Some(capturer),
            should_stop,
            frame_receiver: None,
            frame_width,
            frame_height,
        }
    }

    pub fn start(
        &mut self,
        start_time: SharedInstant,
        screenshot_dir: impl AsRef<Path>,
        recording_options: RecordingOptions,
    ) {
        let mut capturer = self
            .capturer
            .take()
            .expect("Video capturing thread has already been started!");
        let (sender, receiver) = mpsc::channel(2048);

        self.frame_receiver = Some(receiver);
        let screenshot_file_path = screenshot_dir.as_ref().join("screen-capture.jpg");

        std::thread::spawn(move || {
            tracing::trace!("Starting video recording capture thread...");

            let mut frame_count = 0u32;
            let mut last_sampled_frame_count = 0u32;
            let capture_start_time = Instant::now();
            let mut fps_sample_time = Instant::now();
            let mut screenshot_captured: bool = false;
            let take_screenshot_delay = Duration::from_secs(3);
            let mut last_frame: Option<Arc<Vec<u8>>> = None;

            capturer.start_capture();

            loop {
                let screenshot_path = screenshot_file_path.clone();
                let options_clone = recording_options.clone();

                match capturer.get_next_frame() {
                    Ok(Frame::BGRA(frame)) => {
                        let now = Instant::now();

                        let width = frame.width;
                        let height = frame.height;
                        let frame_data = match frame.width == 0 && frame.height == 0 {
                            true => match last_frame.take() {
                                Some(data) => data,
                                None => {
                                    tracing::error!(
                                        "Somehow got an idle frame before any complete frame"
                                    );
                                    continue;
                                }
                            },
                            false => Arc::new(frame.data),
                        };

                        if now - capture_start_time >= take_screenshot_delay && !screenshot_captured
                        {
                            screenshot_captured = true;
                            let mut frame_data_clone = (*frame_data).clone();

                            std::thread::spawn(move || {
                                for chunk in frame_data_clone.chunks_mut(4) {
                                    chunk.swap(0, 2);
                                }

                                let image: ImageBuffer<Rgba<u8>, Vec<u8>> = ImageBuffer::from_raw(
                                    width.try_into().unwrap(),
                                    height.try_into().unwrap(),
                                    frame_data_clone,
                                )
                                .expect("Failed to create image buffer");

                                let mut output_file = std::fs::File::create(&screenshot_path)
                                    .expect("Failed to create output file");
                                let mut encoder =
                                    JpegEncoder::new_with_quality(&mut output_file, 70);

                                if let Err(e) = encoder.encode_image(&image) {
                                    tracing::warn!("Failed to save screenshot: {}", e);
                                } else {
                                    tracing::info!(
                                        "Screenshot captured and saved to {:?}",
                                        screenshot_path
                                    );
                                }

                                if !config::is_local_mode() {
                                    let rt = tokio::runtime::Runtime::new().unwrap();
                                    rt.block_on(async move {
                                        let upload_task = tokio::spawn(upload_recording_asset(
                                            options_clone,
                                            screenshot_path.clone(),
                                            RecordingAssetType::ScreenCapture,
                                            None
                                        ));
                                        match upload_task.await {
                                            Ok(result) => match result {
                                                Ok(_) => tracing::info!(
                                                    "Screenshot successfully uploaded"
                                                ),
                                                Err(e) => {
                                                    tracing::warn!("Failed to upload file: {}", e)
                                                }
                                            },
                                            Err(e) => {
                                                tracing::error!("Failed to join task: {}", e)
                                            }
                                        }
                                    });
                                }
                            });
                        }

                        last_frame = Some(Arc::clone(&frame_data));
                        match sender.try_send(frame_data) {
                            Ok(_) => {
                                let mut first_frame_time_guard = start_time.try_lock();

                                if let Ok(ref mut start_time_option) = first_frame_time_guard {
                                    if start_time_option.is_none() {
                                        **start_time_option = Some(Instant::now());

                                        tracing::trace!("Video start time captured");
                                    }
                                }
                            }
                            Err(TrySendError::Full(_)) => {
                                // TODO: Consider panicking? This should *never* happen
                                tracing::error!("Channel buffer is full!");
                            }
                            _ => {
                                tracing::trace!("Recording has been stopped. Dropping data.");
                                break;
                            }
                        }
                        frame_count += 1;
                    }
                    Ok(_) => unreachable!(),
                    Err(error) => {
                        tracing::error!("Capture error: {}", error);
                        break;
                    }
                }

                let elapsed_time = fps_sample_time.elapsed();
                let elapsed_total_time = capture_start_time.elapsed();
                if elapsed_time > Duration::from_millis(1500) {
                    let delta_frame_count = frame_count - last_sampled_frame_count;
                    let current_fps = (delta_frame_count as f64) / elapsed_time.as_secs_f64();
                    let total_fps = (frame_count as f64) / elapsed_total_time.as_secs_f64();

                    last_sampled_frame_count = frame_count;
                    fps_sample_time = Instant::now();
                    tracing::info!("🏁🏁 Current FPS: {current_fps}, Total FPS: {total_fps}");
                }
            }
        });
    }

    pub fn collect_frames(&mut self, destination: PathBuf) -> impl Future<Output = ()> + 'static {
        tracing::trace!("Starting video channel senders...");
        let mut receiver = self
            .frame_receiver
            .take()
            .expect("Video frame collection already started!");
        let should_stop = self.should_stop.clone();

        async move {
            let mut pipe = File::create(destination).await.unwrap();

            while let Some(bytes) = receiver.recv().await {
                pipe.write_all(&bytes)
                    .await
                    .expect("Failed to write video data to FFmpeg stdin");

                if should_stop.get() {
                    receiver.close();
                }
            }

            let _ = pipe.sync_all().await;
        }
    }
}
