use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::SampleFormat;
use std::process::{Stdio};
use byteorder::{ByteOrder, LittleEndian};
use std::sync::{Arc, atomic::{AtomicBool, Ordering}};
use std::io::{ErrorKind::WouldBlock, Error};
use std::time::{Instant, Duration};
use std::path::Path;
use image::{ImageBuffer, Rgba, ImageFormat};
use image::codecs::jpeg::JpegEncoder;

use tokio::io::{AsyncWriteExt};
use tokio::process::{Command, Child, ChildStdin};
use tokio::sync::{mpsc, Mutex};
use tokio::try_join;

use crate::recording::RecordingOptions;
use crate::utils::{ffmpeg_path_as_str};
use crate::upload::upload_file;
use capture::{Capturer, Display};

const FRAME_RATE: u64 = 30;

pub struct MediaRecorder {
    pub options: Option<RecordingOptions>,
    ffmpeg_audio_process: Option<tokio::process::Child>,
    ffmpeg_video_process: Option<tokio::process::Child>,
    ffmpeg_audio_stdin: Option<Arc<Mutex<Option<tokio::process::ChildStdin>>>>,
    ffmpeg_video_stdin: Option<Arc<Mutex<Option<tokio::process::ChildStdin>>>>,
    device_name: Option<String>,
    stream: Option<cpal::Stream>,
    audio_channel_sender: Option<mpsc::Sender<Vec<u8>>>,
    audio_channel_receiver: Option<mpsc::Receiver<Vec<u8>>>,
    video_channel_sender: Option<mpsc::Sender<Vec<u8>>>,
    video_channel_receiver: Option<mpsc::Receiver<Vec<u8>>>,
    should_stop: Arc<AtomicBool>,
    start_time: Option<Instant>,
    audio_file_path: Option<String>,
    video_file_path: Option<String>,
}

impl MediaRecorder {

    pub fn new() -> Self {
        MediaRecorder {
            options: None,
            ffmpeg_audio_process: None,
            ffmpeg_video_process: None,
            ffmpeg_audio_stdin: None,
            ffmpeg_video_stdin: None,
            device_name: None,
            stream: None,
            audio_channel_sender: None,
            audio_channel_receiver: None,
            video_channel_sender: None,
            video_channel_receiver: None,
            should_stop: Arc::new(AtomicBool::new(false)),
            start_time: None,
            audio_file_path: None,
            video_file_path: None,
        }
    }

    pub async fn start_media_recording(&mut self, options: RecordingOptions, audio_file_path: &str, video_file_path: &str, screenshot_file_path: &str, custom_device: Option<&str>, max_screen_width: usize, max_screen_height: usize) -> Result<(), String> {
        self.options = Some(options.clone());

        println!("Custom device: {:?}", custom_device);
        
        let host = cpal::default_host();
        let devices = host.devices().expect("Failed to get devices");
        let _display = Display::primary().expect("Failed to find primary display");
        let w = max_screen_width;
        let h = max_screen_height;
        
        let adjusted_width = w & !2;
        let adjusted_height = h & !2;
        let capture_size = adjusted_width * adjusted_height * 4;
        let (audio_tx, audio_rx) = tokio::sync::mpsc::channel::<Vec<u8>>(2048);
        let (video_tx, video_rx) = tokio::sync::mpsc::channel::<Vec<u8>>(2048);
        let calculated_stride = (adjusted_width * 4) as usize;
        
        println!("Display width: {}", w);
        println!("Display height: {}", h);
        println!("Adjusted width: {}", adjusted_width);
        println!("Adjusted height: {}", adjusted_height);
        println!("Capture size: {}", capture_size);
        println!("Calculated stride: {}", calculated_stride);

        let audio_start_time = Arc::new(Mutex::new(None));
        let video_start_time = Arc::new(Mutex::new(None));

        self.audio_channel_sender = Some(audio_tx);
        self.audio_channel_receiver = Some(audio_rx);
        self.video_channel_sender = Some(video_tx);
        self.video_channel_receiver = Some(video_rx);
        self.ffmpeg_audio_stdin = Some(Arc::new(Mutex::new(None)));
        self.ffmpeg_video_stdin = Some(Arc::new(Mutex::new(None)));

        let audio_channel_sender = self.audio_channel_sender.clone();
        let video_channel_sender = self.video_channel_sender.clone();

        let audio_channel_receiver = Arc::new(Mutex::new(self.audio_channel_receiver.take()));
        let video_channel_receiver = Arc::new(Mutex::new(self.video_channel_receiver.take()));

        let should_stop = Arc::clone(&self.should_stop);
        
        let mut input_devices = devices.filter_map(|device| {
            let supported_input_configs = device.supported_input_configs();
            if supported_input_configs.is_ok() && supported_input_configs.unwrap().count() > 0 {
                Some(device)
            } else {
                None
            }
        });

        let device = if let Some(custom_device_name) = custom_device {
            input_devices
                .find(|d| d.name().map(|name| name == custom_device_name).unwrap_or(false))
                .unwrap_or_else(|| host.default_input_device().expect("No default input device available"))
        } else {
            host.default_input_device().expect("No default input device available")
        };

        println!("Using audio device: {}", device.name().expect("Failed to get device name"));

        let config = device.supported_input_configs()
            .expect("Failed to get supported input configs")
            .find(|c| c.sample_format() == SampleFormat::F32 || c.sample_format() == SampleFormat::I16 || c.sample_format() == SampleFormat::I8 || c.sample_format() == SampleFormat::I32)
            .unwrap_or_else(||
                device.supported_input_configs().expect("Failed to get supported input configs").next().expect("No supported input config")
            )
            .with_max_sample_rate();

        let sample_rate = config.sample_rate().0;
        let channels = config.channels();
        let sample_format = match config.sample_format() {
            SampleFormat::I8 => "s8",
            SampleFormat::I16 => "s16le",
            SampleFormat::I32 => "s32le",
            SampleFormat::F32 => "f32le",
            _ => panic!("Unsupported sample format."),
        };

        println!("Sample rate: {}", sample_rate);
        println!("Channels: {}", channels);
        println!("Sample format: {}", sample_format);
        
        let ffmpeg_binary_path_str = ffmpeg_path_as_str().unwrap().to_owned();

        println!("FFmpeg binary path: {}", ffmpeg_binary_path_str);
        
        let audio_file_path_owned = audio_file_path.to_owned();
        let video_file_path_owned = video_file_path.to_owned();
        let sample_rate_str = sample_rate.to_string();
        let channels_str = channels.to_string();
        
        let ffmpeg_audio_stdin = self.ffmpeg_audio_stdin.clone();
        let ffmpeg_video_stdin = self.ffmpeg_video_stdin.clone();

        let err_fn = move |err| {
            eprintln!("an error occurred on stream: {}", err);
        };
        
        if custom_device != Some("None") {
            println!("Building input stream...");

            let stream_result: Result<cpal::Stream, cpal::BuildStreamError> = match config.sample_format() {
              SampleFormat::I8 => device.build_input_stream(
                  &config.into(),
                  {
                      let audio_start_time = Arc::clone(&audio_start_time);
                      move |data: &[i8], _: &_| {
                          let mut first_frame_time_guard = audio_start_time.try_lock();
                          
                          let bytes = data.iter().map(|&sample| sample as u8).collect::<Vec<u8>>();
                          if let Some(sender) = &audio_channel_sender {
                            if sender.try_send(bytes).is_err() {
                              eprintln!("Channel send error. Dropping data.");
                            }
                          }
                          
                          if let Ok(ref mut start_time_option) = first_frame_time_guard {
                              if start_time_option.is_none() {
                                  **start_time_option = Some(Instant::now()); 

                                  println!("Audio start time captured");
                              }
                          }
                      }
                  },
                  err_fn,
                  None,
              ),
              SampleFormat::I16 => device.build_input_stream(
                  &config.into(),
                  {
                      let audio_start_time = Arc::clone(&audio_start_time); 
                      move |data: &[i16], _: &_| {
                          let mut first_frame_time_guard = audio_start_time.try_lock();

                          let mut bytes = vec![0; data.len() * 2];
                          LittleEndian::write_i16_into(data, &mut bytes);
                          if let Some(sender) = &audio_channel_sender {
                              if sender.try_send(bytes).is_err() {
                                  eprintln!("Channel send error. Dropping data.");
                              }
                          }

                          if let Ok(ref mut start_time_option) = first_frame_time_guard {
                              if start_time_option.is_none() {
                                  **start_time_option = Some(Instant::now()); 

                                  println!("Audio start time captured");
                              }
                          }
                      }
                  },
                  err_fn,
                  None,
              ),
              SampleFormat::I32 => device.build_input_stream(
                  &config.into(),
                  {
                      let audio_start_time = Arc::clone(&audio_start_time);
                      move |data: &[i32], _: &_| {
                          let mut first_frame_time_guard = audio_start_time.try_lock();

                          let mut bytes = vec![0; data.len() * 2];
                          LittleEndian::write_i32_into(data, &mut bytes);
                          if let Some(sender) = &audio_channel_sender {
                              if sender.try_send(bytes).is_err() {
                                  eprintln!("Channel send error. Dropping data.");
                              }
                          }

                          if let Ok(ref mut start_time_option) = first_frame_time_guard {
                              if start_time_option.is_none() {
                                  **start_time_option = Some(Instant::now()); 

                                  println!("Audio start time captured");
                              }
                          }
                      }
                  },
                  err_fn,
                  None,
              ),
              SampleFormat::F32 => device.build_input_stream(
                  &config.into(),
                  {
                      let audio_start_time = Arc::clone(&audio_start_time);
                      move |data: &[f32], _: &_| {
                          let mut first_frame_time_guard = audio_start_time.try_lock();

                          let mut bytes = vec![0; data.len() * 4];
                          LittleEndian::write_f32_into(data, &mut bytes);
                          if let Some(sender) = &audio_channel_sender {
                              if sender.try_send(bytes).is_err() {
                                  eprintln!("Channel send error. Dropping data.");
                              }
                          }

                          if let Ok(ref mut start_time_option) = first_frame_time_guard {
                              if start_time_option.is_none() {
                                  **start_time_option = Some(Instant::now()); 

                                  println!("Audio start time captured");
                              }
                          }
                      }
                  },
                  err_fn,
                  None,
              ),
              _sample_format => Err(cpal::BuildStreamError::DeviceNotAvailable),
            };
            
            let stream = stream_result.map_err(|_| "Failed to build input stream")?;
            self.stream = Some(stream);
            self.trigger_play()?;
        }

        let video_start_time_clone = Arc::clone(&video_start_time); 
        let screenshot_file_path_owned = format!("{}/screen-capture.jpg", screenshot_file_path);
        let capture_frame_at = Duration::from_secs(3);
        
        std::thread::spawn(move || {
            println!("Starting video recording capture thread...");

            let is_local_mode = match dotenv_codegen::dotenv!("NEXT_PUBLIC_LOCAL_MODE") {
                "true" => true,
                _ => false,
            };

            let mut capturer = Capturer::new(Display::primary().expect("Failed to find primary display"), w.try_into().unwrap(), h.try_into().unwrap()).expect("Failed to start capture");

            let fps = FRAME_RATE;
            let spf = Duration::from_nanos(1_000_000_000 / fps);

            let mut frame_count = 0u32;
            let start_time = Instant::now();
            let mut time_next = Instant::now() + spf;
            let mut screenshot_captured: bool = false;
            
            while !should_stop.load(Ordering::SeqCst) {
                let options_clone = options.clone();
                let now = Instant::now();

                if now >= time_next {
                    match capturer.frame() {
                        Ok(frame) => {
                            let mut frame_data = Vec::with_capacity(capture_size.try_into().unwrap());

                            for row in 0..adjusted_height {
                                let padded_stride = frame.stride_override().unwrap_or(calculated_stride);
                                assert!(padded_stride >= calculated_stride, "Image stride with padding should not be smaller than calculated bytes per row");
                                // Each row should skip the padding of the previous row
                                let start = row * padded_stride;
                                // Each row should stop before/trim off its padding, for compatibility with software that doesn't follow arbitrary padding.
                                let end = start + calculated_stride;
                                frame_data.extend_from_slice(&frame[start..end]);
                            }

                            if now - start_time >= capture_frame_at && !screenshot_captured {
                                screenshot_captured = true;
                                let screenshot_file_path_owned_cloned = screenshot_file_path_owned.clone();
                                let mut frame_data_clone = frame_data.clone();

                                std::thread::spawn(move || {
                                    for chunk in frame_data_clone.chunks_mut(4) {
                                        chunk.swap(0, 2);
                                    }

                                    let path = Path::new(&screenshot_file_path_owned_cloned);
                                    let image: ImageBuffer<Rgba<u8>, Vec<u8>> = ImageBuffer::from_raw(
                                        adjusted_width.try_into().unwrap(),
                                        adjusted_height.try_into().unwrap(),
                                        frame_data_clone
                                    ).expect("Failed to create image buffer");

                                    let mut output_file = std::fs::File::create(&path).expect("Failed to create output file");
                                    let mut encoder = JpegEncoder::new_with_quality(&mut output_file, 20);

                                    if let Err(e) = encoder.encode_image(&image) {
                                        eprintln!("Failed to save screenshot: {}", e);
                                    } else {
                                        if !is_local_mode {
                                            let rt = tokio::runtime::Runtime::new().unwrap();
                                            let screenshot_file_path_owned_cloned_copy = screenshot_file_path_owned_cloned.clone();
                                            rt.block_on(async {
                                                let upload_task = tokio::spawn(upload_file(Some(options_clone), screenshot_file_path_owned_cloned_copy.clone(), "screenshot".to_string()));
                                                match upload_task.await {
                                                    Ok(result) => {
                                                        match result {
                                                            Ok(_) => println!("Screenshot captured and saved to {:?}", path),
                                                            Err(e) => eprintln!("Failed to upload file: {}", e),
                                                        }
                                                    },
                                                    Err(e) => eprintln!("Failed to join task: {}", e),
                                                }
                                            });
                                        }
                                        println!("Screenshot captured and saved to {:?}", path);
                                    }
                                });
                            }

                            if let Some(sender) = &video_channel_sender {
                                if sender.try_send(frame_data).is_err() {
                                    eprintln!("Channel send error. Dropping data.");
                                }
                            }

                            let mut first_frame_time_guard = video_start_time_clone.try_lock();

                            if let Ok(ref mut start_time_option) = first_frame_time_guard {
                                if start_time_option.is_none() {
                                    **start_time_option = Some(Instant::now()); 

                                    println!("Video start time captured");
                                }
                            }

                            frame_count += 1;
                        },
                        Err(error) if error.kind() == WouldBlock => {
                            std::thread::sleep(Duration::from_millis(1));
                            continue;
                        },
                        Err(error) => {
                            eprintln!("Capture error: {}", error);
                            break;
                        },
                    }

                    time_next += spf;
                }

                // Sleep until the next frame time
                let now = Instant::now();
                if time_next > now {
                    std::thread::sleep(time_next - now);
                }
            }

            let elapsed_total_time = start_time.elapsed();
            let fps = frame_count as f64 / elapsed_total_time.as_secs_f64();
            println!("Current FPS: {}", fps);
        });

        println!("Starting audio recording and processing...");
        let audio_output_chunk_pattern = format!("{}/audio_recording_%03d.aac", audio_file_path_owned);
        let audio_segment_list_filename = format!("{}/segment_list.txt", audio_file_path_owned);
        let video_output_chunk_pattern = format!("{}/video_recording_%03d.ts", video_file_path_owned);
        let video_segment_list_filename = format!("{}/segment_list.txt", video_file_path_owned);
      
        let mut audio_filters = Vec::new();

        if channels > 2 {
            audio_filters.push("pan=stereo|FL=FL+0.5*FC|FR=FR+0.5*FC");
        }

        audio_filters.push("loudnorm");

        let mut ffmpeg_audio_command: Vec<String> = vec![
            "-f", sample_format,
            "-ar", &sample_rate_str,
            "-ac", &channels_str,
            "-thread_queue_size", "4096",
            "-i", "pipe:0",
            "-af", "aresample=async=1:min_hard_comp=0.100000:first_pts=0",
            "-c:a", "aac",
            "-b:a", "128k",
            "-async", "1",
            "-f", "segment",
            "-segment_time", "3",
            "-segment_time_delta", "0.01",
            "-segment_list", &audio_segment_list_filename,
            "-reset_timestamps", "1",
            &audio_output_chunk_pattern,
        ].into_iter().map(|s| s.to_string()).collect();

        let mut ffmpeg_video_command: Vec<String> = vec![
            "-f", "rawvideo",
            "-pix_fmt", "bgra",
            "-s", &format!("{}x{}", adjusted_width, adjusted_height),
            "-r", "30",
            "-thread_queue_size", "4096",
            "-i", "pipe:0",
            "-vf", "fps=30,scale=in_range=full:out_range=limited",
            "-c:v", "libx264",
            "-preset", "ultrafast",
            "-pix_fmt", "yuv420p",
            "-tune", "zerolatency",
            "-vsync", "1",
            "-force_key_frames", "expr:gte(t,n_forced*3)",
            "-f", "segment",
            "-segment_time", "3",
            "-segment_time_delta", "0.01",
            "-segment_list", &video_segment_list_filename,
            "-segment_format", "ts",
            "-movflags", "frag_keyframe+empty_moov",
            "-reset_timestamps", "1",
            &video_output_chunk_pattern,
        ].into_iter().map(|s| s.to_string()).collect();

        if custom_device != Some("None") {
            println!("Adjusting FFmpeg commands based on start times...");
            adjust_ffmpeg_commands_based_on_start_times(
                Arc::clone(&audio_start_time),
                Arc::clone(&video_start_time),
                &mut ffmpeg_audio_command,
                &mut ffmpeg_video_command,
            ).await;
        }

        println!("Starting FFmpeg audio and video processes...");

        let mut audio_stdin: Option<ChildStdin> = None;
        let mut audio_child: Option<Child> = None;

        if custom_device != Some("None") {
            let (child, stdin) = self.start_audio_ffmpeg_processes(&ffmpeg_binary_path_str, &ffmpeg_audio_command).await.map_err(|e| e.to_string())?;
            audio_child = Some(child);
            audio_stdin = Some(stdin);
            println!("Audio process started");
        }

        let (video_child, video_stdin) = self.start_video_ffmpeg_processes(&ffmpeg_binary_path_str, &ffmpeg_video_command).await.map_err(|e| e.to_string())?;
        println!("Video process started");
        
        if let Some(ffmpeg_audio_stdin) = &self.ffmpeg_audio_stdin {
            let mut audio_stdin_lock = ffmpeg_audio_stdin.lock().await;
            *audio_stdin_lock = audio_stdin;
            drop(audio_stdin_lock);
            println!("Audio stdin set");
        }

        if let Some(ffmpeg_video_stdin) = &self.ffmpeg_video_stdin {
            let mut video_stdin_lock = ffmpeg_video_stdin.lock().await;
            *video_stdin_lock = Some(video_stdin);
            drop(video_stdin_lock);
            println!("Video stdin set");
        }

        if custom_device != Some("None") {
            println!("Starting audio channel senders...");
            tokio::spawn(async move {
                while let Some(bytes) = &audio_channel_receiver.lock().await.as_mut().unwrap().recv().await {
                    if let Some(audio_stdin_arc) = &ffmpeg_audio_stdin{
                        let mut audio_stdin_guard = audio_stdin_arc.lock().await;
                        if let Some(ref mut stdin) = *audio_stdin_guard {
                            stdin.write_all(&bytes).await.expect("Failed to write audio data to FFmpeg stdin");
                        }
                        drop(audio_stdin_guard);
                    }
                }
            });
        }

        println!("Starting video channel senders...");
        tokio::spawn(async move {
            while let Some(bytes) = &video_channel_receiver.lock().await.as_mut().unwrap().recv().await {
                if let Some(video_stdin_arc) = &ffmpeg_video_stdin {
                    let mut video_stdin_guard = video_stdin_arc.lock().await;
                    if let Some(ref mut stdin) = *video_stdin_guard {
                        stdin.write_all(&bytes).await.expect("Failed to write video data to FFmpeg stdin");
                    }
                    drop(video_stdin_guard);
                }
            }
        });
        
        if custom_device != Some("None") {
            self.ffmpeg_audio_process = audio_child;
        }

        self.start_time = Some(Instant::now());
        self.audio_file_path = Some(audio_file_path_owned);
        self.video_file_path = Some(video_file_path_owned);
        self.ffmpeg_video_process = Some(video_child);
        self.device_name = Some(device.name().expect("Failed to get device name"));
        
        println!("End of the start_audio_recording function");
        
        Ok(())
    }

    pub fn trigger_play (&mut self) -> Result<(), &'static str> {
        if let Some(ref mut stream) = self.stream {
            stream.play().map_err(|_| "Failed to play stream")?;
            println!("Audio recording playing.");
        } else {
            return Err("Starting the recording did not work");
        }

        Ok(())
    }

    pub async fn stop_media_recording(&mut self) -> Result<(), String> {
        if let Some(start_time) = self.start_time {
            let segment_duration = Duration::from_secs(3);
            let recording_duration = start_time.elapsed();
            let expected_segments = recording_duration.as_secs() / segment_duration.as_secs();
            let audio_file_path = self.audio_file_path.as_ref().ok_or("Audio file path not set")?;
            let video_file_path = self.video_file_path.as_ref().ok_or("Video file path not set")?;
            let audio_segment_list_filename = format!("{}/segment_list.txt", audio_file_path);
            let video_segment_list_filename = format!("{}/segment_list.txt", video_file_path);

            loop {
                let audio_segments = std::fs::read_to_string(&audio_segment_list_filename).unwrap_or_default();
                let video_segments = std::fs::read_to_string(&video_segment_list_filename).unwrap_or_default();

                let audio_segment_count = audio_segments.lines().count();
                let video_segment_count = video_segments.lines().count();

                if audio_segment_count >= expected_segments as usize && video_segment_count >= expected_segments as usize {
                    println!("All segments generated");
                    break;
                }

                tokio::time::sleep(Duration::from_millis(300)).await;
            }
        }

        if let Some(ref ffmpeg_audio_stdin) = self.ffmpeg_audio_stdin {
            let mut audio_stdin_guard = ffmpeg_audio_stdin.lock().await;
            if let Some(mut audio_stdin) = audio_stdin_guard.take() {
                if let Err(e) = audio_stdin.write_all(b"q\n").await {
                    eprintln!("Failed to send 'q' to audio FFmpeg process: {}", e);
                }
                let _ = audio_stdin.shutdown().await.map_err(|e| e.to_string());
            }
        }

        if let Some(ref ffmpeg_video_stdin) = self.ffmpeg_video_stdin {
            let mut video_stdin_guard = ffmpeg_video_stdin.lock().await;
            if let Some(mut video_stdin) = video_stdin_guard.take() {
                if let Err(e) = video_stdin.write_all(b"q\n").await {
                    eprintln!("Failed to send 'q' to video FFmpeg process: {}", e);
                }
                let _ = video_stdin.shutdown().await.map_err(|e| e.to_string());
            }
        }

        self.should_stop.store(true, Ordering::SeqCst);

        if let Some(sender) = self.audio_channel_sender.take() {
            drop(sender);
        }

        if let Some(sender) = self.video_channel_sender.take() {
            drop(sender);
        }

        if let Some(ref mut stream) = self.stream {
            stream.pause().map_err(|_| "Failed to pause stream")?;
            println!("Audio recording paused.");
        } else {
            return Err("Original recording was not started".to_string());
        }

        if let Some(process) = &mut self.ffmpeg_audio_process {
            let _ = process.kill().await.map_err(|e| e.to_string());
        }

        if let Some(process) = &mut self.ffmpeg_video_process {
            let _ = process.kill().await.map_err(|e| e.to_string());
        }

        println!("Audio recording stopped.");
        Ok(())
    }

    async fn start_audio_ffmpeg_processes(
        &self,
        ffmpeg_binary_path: &str,
        audio_ffmpeg_command: &[String],
    ) -> Result<(Child, ChildStdin), Error> {
        let mut audio_process = start_recording_process(ffmpeg_binary_path, audio_ffmpeg_command).await.map_err(|e| {
            eprintln!("Failed to start audio recording process: {}", e);
            std::io::Error::new(std::io::ErrorKind::Other, e.to_string())
        })?;

        let audio_stdin = audio_process.stdin.take().ok_or_else(|| {
            eprintln!("Failed to take audio stdin");
            std::io::Error::new(std::io::ErrorKind::Other, "Failed to take audio stdin")
        })?;

        Ok((audio_process, audio_stdin))
    }

    async fn start_video_ffmpeg_processes(
        &self,
        ffmpeg_binary_path: &str,
        video_ffmpeg_command: &[String],
    ) -> Result<(Child, ChildStdin), Error> {
        let mut video_process = start_recording_process(ffmpeg_binary_path, video_ffmpeg_command).await.map_err(|e| {
            eprintln!("Failed to start video recording process: {}", e);
            std::io::Error::new(std::io::ErrorKind::Other, e.to_string())
        })?;

        let video_stdin = video_process.stdin.take().ok_or_else(|| {
            eprintln!("Failed to take video stdin");
            std::io::Error::new(std::io::ErrorKind::Other, "Failed to take video stdin")
        })?;

        Ok((video_process, video_stdin))
    }

}

#[tauri::command]
pub fn enumerate_audio_devices() -> Vec<String> {
    let host = cpal::default_host();
    let default_device = host.default_input_device().expect("No default input device available");
    let default_device_name = default_device.name().expect("Failed to get default device name");

    let devices = host.devices().expect("Failed to get devices");
    let mut input_device_names: Vec<String> = devices
        .filter_map(|device| {
            let supported_input_configs = device.supported_input_configs();
            if supported_input_configs.is_ok() && supported_input_configs.unwrap().count() > 0 {
                device.name().ok()
            } else {
                None
            }
        })
        .collect();

    input_device_names.retain(|name| name != &default_device_name);
    input_device_names.insert(0, default_device_name);

    input_device_names
}

use tokio::io::{BufReader, AsyncBufReadExt};

async fn start_recording_process(
    ffmpeg_binary_path_str: &str, 
    args: &[String], 
) -> Result<tokio::process::Child, std::io::Error> {
    let mut process = Command::new(ffmpeg_binary_path_str)
        .args(args)
        .stdin(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;

    if let Some(process_stderr) = process.stderr.take() {
      tokio::spawn(async move {
            let mut process_reader = BufReader::new(process_stderr).lines();
            while let Ok(Some(line)) = process_reader.next_line().await {
                eprintln!("FFmpeg process STDERR: {}", line);
            }
        });
    }

    Ok(process)
}

async fn wait_for_start_times(
    audio_start_time: Arc<Mutex<Option<Instant>>>,
    video_start_time: Arc<Mutex<Option<Instant>>>,
) -> (Instant, Instant) {
    loop {
        let audio_start_locked = audio_start_time.lock().await;
        let video_start_locked = video_start_time.lock().await;
        
        if audio_start_locked.is_some() && video_start_locked.is_some() {
            let audio_start = *audio_start_locked.as_ref().unwrap();
            let video_start = *video_start_locked.as_ref().unwrap();
            return (audio_start, video_start);
        }
        drop(audio_start_locked);
        drop(video_start_locked);
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

async fn adjust_ffmpeg_commands_based_on_start_times(
    audio_start_time: Arc<Mutex<Option<Instant>>>,
    video_start_time: Arc<Mutex<Option<Instant>>>,
    ffmpeg_audio_command: &mut Vec<String>,
    ffmpeg_video_command: &mut Vec<String>,
) {
    let (audio_start, video_start) = wait_for_start_times(audio_start_time, video_start_time).await;
    let duration_difference = if audio_start > video_start {
        audio_start.duration_since(video_start)
    } else {
        video_start.duration_since(audio_start)
    };

    println!("Duration difference: {:?}", duration_difference);
    println!("Audio start: {:?}", audio_start);
    println!("Video start: {:?}", video_start);

    // Convert the duration difference to a float representing seconds
    let offset_seconds = duration_difference.as_secs() as f64 
        + duration_difference.subsec_nanos() as f64 * 1e-9;

    // Depending on which started first, adjust the relevant FFmpeg command
    if audio_start > video_start {
        // Offset the video start time
        ffmpeg_video_command.splice(0..0, vec![
            "-itsoffset".to_string(), format!("{:.3}", offset_seconds)
        ]);
        println!("Applying -itsoffset {:.3} to video", offset_seconds);
    } else if video_start > audio_start {
        // Offset the audio start time
        ffmpeg_audio_command.splice(0..0, vec![
            "-itsoffset".to_string(), format!("{:.3}", offset_seconds)
        ]);
        println!("Applying -itsoffset {:.3} to audio", offset_seconds);
    }

}