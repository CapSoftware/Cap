use image::codecs::jpeg::JpegEncoder;
use image::{ImageBuffer, Rgba};
use scap::{
    capturer::{Capturer, Options, Resolution},
    frame::{Frame, FrameType},
};
use std::{
    future::Future,
    path::{Path, PathBuf},
    time::Duration,
};
use tokio::sync::mpsc::error::TrySendError;
use tokio::{fs::File, io::AsyncWriteExt, sync::mpsc};

use super::{Instant, RecordingOptions, SharedFlag, SharedInstant};
use crate::app::config;
use crate::upload::{upload_file, FileType};

pub struct VideoCapturer {
    capturer: Option<Capturer>,
    should_stop: SharedFlag,
    pub frame_width: u32,
    pub frame_height: u32,
    frame_receiver: Option<mpsc::Receiver<Vec<u8>>>,
}

impl VideoCapturer {
    pub fn new(_width: usize, _height: usize, should_stop: SharedFlag) -> VideoCapturer {
        let mut capturer = Capturer::new(Options {
            fps: 60,
            target: None,
            show_cursor: true,
            show_highlight: true,
            excluded_targets: None,
            output_type: FrameType::BGRAFrame,
            output_resolution: Resolution::Captured,
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
        let should_stop = self.should_stop.clone();

        std::thread::spawn(move || {
            tracing::trace!("Starting video recording capture thread...");

            let capture_start_time = Instant::now();
            let mut screenshot_captured: bool = false;
            let take_screenshot_delay = Duration::from_secs(3);

            capturer.start_capture();

            loop {
                let screenshot_path = screenshot_file_path.clone();
                let options_clone = recording_options.clone();

                match capturer.get_next_frame() {
                    Ok(Frame::BGRA(frame)) => {
                        // TODO: Check if stride needs adjusting. Implement that in scap instead of here?
                        let now = Instant::now();

                        if now - capture_start_time >= take_screenshot_delay && !screenshot_captured
                        {
                            screenshot_captured = true;
                            let mut frame_data_clone = frame.data.clone();

                            std::thread::spawn(move || {
                                for chunk in frame_data_clone.chunks_mut(4) {
                                    chunk.swap(0, 2);
                                }

                                let image: ImageBuffer<Rgba<u8>, Vec<u8>> = ImageBuffer::from_raw(
                                    frame.width.try_into().unwrap(),
                                    frame.height.try_into().unwrap(),
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
                                        let upload_task = tokio::spawn(upload_file(
                                            Some(options_clone),
                                            screenshot_path.clone(),
                                            FileType::Screenshot,
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

                        match sender.try_send(frame.data) {
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
                                tracing::info!("Recording has been stopped. Dropping data.");
                                break;
                            }
                        }
                    }
                    Ok(_) => unreachable!(),
                    Err(error) => {
                        tracing::error!("Capture error: {}", error);
                        break;
                    }
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
        }
    }
}
