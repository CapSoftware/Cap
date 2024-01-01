use std::io::{ErrorKind::WouldBlock, Write};
use std::process::{Command};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use std::path::{PathBuf, Path};
use std::fs;
use std::fs::File;
use std::sync::atomic::{AtomicBool, Ordering};
use capture::{Capturer, Display};
use tauri::{Window};
use super::upload_video;

#[derive(Clone, PartialEq)]
pub enum RecordingState {
    Idle,
    Recording,
    Stopping,
}

pub struct ScreenRecorder {
    state: Arc<Mutex<RecordingState>>,
    ffmpeg_handle: Mutex<Option<thread::JoinHandle<Result<(), String>>>>,
    ffmpeg_path: PathBuf,
    should_stop: Arc<AtomicBool>,
    user_id: Option<String>,
    window: Window
}

const BYTES_PER_PIXEL: usize = 4;

impl ScreenRecorder {
  
    pub fn new(ffmpeg_path: PathBuf, window: Window) -> Self {
        Self {
            state: Arc::new(Mutex::new(RecordingState::Idle)),
            ffmpeg_handle: Mutex::new(None),
            ffmpeg_path,
            should_stop: Arc::new(AtomicBool::new(false)),
            user_id: None,
            window
        }
    }

    pub fn set_user_id(&mut self, user_id: String) {
        self.user_id = Some(user_id);
    }

    pub fn start_recording(&self) -> Result<(), String> {
        let state = self.state.clone();
        let should_stop = Arc::clone(&self.should_stop);
        let ffmpeg_path = self.ffmpeg_path.clone();
        let user_id = self.user_id.clone();
        let window = self.window.clone();

        println!("Start recording requested.");

        // Ensure we have a primary display to capture
        let display = Display::primary().map_err(|_| "Failed to find primary display".to_string())?;
        let (w, h) = (display.width(), display.height());
        let adjusted_height = h & !1;
        let capture_size = w * adjusted_height * BYTES_PER_PIXEL;
        let framerate = 60;

        println!("Display: {}x{}", w, h);

        // Check current recording state
        let mut state_guard = state.lock().map_err(|_| "Failed to acquire state lock".to_string())?;
        if *state_guard != RecordingState::Idle {
            return Err("Recording is already in progress".to_owned());
        }
        *state_guard = RecordingState::Recording;
        drop(state_guard);

        println!("Starting recording...");

        // Define paths for recordings and temp data
        let recordings_dir = Path::new("recordings");
        let tmp_file_path = recordings_dir.join("temporary_capture.raw");
        let output_path = recordings_dir.join("recording.mp4").to_owned();

        fs::create_dir_all(&recordings_dir).map_err(|e| format!("Failed to create recordings directory: {}", e))?;

        println!("Temporary file path: {}", tmp_file_path.to_str().ok_or_else(|| "Failed to convert temporary file path to string".to_owned())?);

        // Delete existing temporary and final output files if they exist
        if tmp_file_path.exists() {
            std::fs::remove_file(&tmp_file_path).map_err(|e| format!("Failed to delete existing temp file: {}", e))?;
        }
        if output_path.exists() {
            std::fs::remove_file(&output_path).map_err(|e| format!("Failed to delete existing final output file: {}", e))?;
        }

        println!("Output file path: {}", output_path.to_str().ok_or_else(|| "Failed to convert output file path to string".to_owned())?);

        let output_path_str = output_path.to_str().ok_or_else(|| "Failed to construct output file path string".to_string())?.to_owned();

        let ffmpeg_handle = thread::spawn(move || {
            println!("Starting capture...");

            let mut capturer = Capturer::new(display).expect("Failed to start capture");
            let (sender, receiver) = std::sync::mpsc::channel::<Vec<u8>>();
            let frame_duration = Duration::from_secs_f64(1.0 / framerate as f64);

            let write_handle = {
                let tmp_file_path = tmp_file_path.clone(); 
                let buffer_size = 100;
                let mut buffer = Vec::new();
                thread::spawn(move || {
                    let mut raw_file = File::create(&tmp_file_path).expect("Failed to create temporary raw file");
                    for data in receiver {
                        buffer.push(data);
                        if buffer.len() >= buffer_size {
                            for frame_data in buffer.drain(..) {
                                raw_file.write_all(&frame_data).expect("Failed to write frame data to file");
                            }
                        }
                    }
                    // Write any remaining frames in the buffer
                    for frame_data in buffer {
                        raw_file.write_all(&frame_data).expect("Failed to write frame data to file");
                    }
                })
            };

            // Capture loop
            while !should_stop.load(Ordering::SeqCst) {
                let time_started = Instant::now();
                let frame = match capturer.frame() {
                    Ok(frame) => frame,
                    Err(error) if error.kind() == WouldBlock => {
                        continue;
                    },
                    Err(error) => return Err(format!("Capture error: {}", error)),
                };
                
                let stride = frame[..capture_size].len() / adjusted_height;
                let mut frame_data = Vec::with_capacity(capture_size);
                for row in 0..adjusted_height {
                    let start = row * stride;
                    let end = start + stride;
                    frame_data.extend_from_slice(&frame[start..end]);
                }

                sender.send(frame_data).expect("Failed to send frame data to the writer thread");
            }

            println!("Capture stopped.");

            // End capture loop
            drop(sender); // Send the terminating signal to the writing thread.
            write_handle.join().expect("Failed to join the writer handle");

            println!("Encoding video...");

            // Encoding with FFmpeg
            let status = Command::new(&ffmpeg_path)
                .args(&[
                    "-f", "rawvideo",
                    "-pix_fmt", "bgra",
                    "-s", &format!("{}x{}", w, adjusted_height),
                    "-r", &framerate.to_string(),
                    "-i", tmp_file_path.to_str().ok_or_else(|| "Failed to convert temporary file path to string".to_owned())?,
                    "-c:v", "libx264",
                    "-preset", "veryfast",
                    "-crf", "15",
                    "-pix_fmt", "yuv420p",
                    "-y", // Overwrite output file without asking
                    "-movflags", "+faststart",
                    &output_path_str,
                ])
                .output();

            println!("Encoding finished.");
            // Handle the FFmpeg output
            match status {
                Ok(output) if output.status.success() => {
                    // Encoding succeeded, remove the temporary file
                    let _ = fs::remove_file(&tmp_file_path);
                    println!("Encoding succeeded.");

                    if let Some(user_id) = &user_id {
                        println!("Uploading video...");

                        match tauri::async_runtime::block_on(upload_video(window.clone(), user_id.clone(), output_path_str.clone())) {
                            Ok(_) => println!("Video uploaded successfully."),
                            Err(e) => eprintln!("Video upload encountered an error: {}", e),
                        }
                    }

                    Ok(())
                },
                Ok(output) => {
                    // Encoding failed - handle the error and FFmpeg's output accordingly
                    let stderr = String::from_utf8_lossy(&output.stderr);
                    Err(format!("FFmpeg failed with error: {}", stderr))
                },
                Err(e) => {
                    // FFmpeg failed to start or some other error occurred while waiting for it to complete
                    Err(format!("Failed to start encoding process: {}", e))
                }
            }
        });

        // Save the handle to join later
        *self.ffmpeg_handle.lock().unwrap() = Some(ffmpeg_handle);

        Ok(())
    }


    pub fn stop_recording(&self) -> Result<(), String> {
        println!("Stop recording requested.");

        // Check if recording is in progress or stopping
        {
            let state_guard = self.state.lock().map_err(|_| "Failed to acquire state lock".to_string())?;
            if *state_guard == RecordingState::Idle {
                println!("Recording is not in progress.");
                return Ok(());
            }
        }

        // Mark the flag to stop recording
        self.should_stop.store(true, Ordering::SeqCst);

        // Wait for the recording thread to finish
        {
            let mut handle = self.ffmpeg_handle.lock().map_err(|_| "Failed to acquire ffmpeg_handle lock".to_string())?;
            if let Some(ffmpeg_handle) = handle.take() {
                // Join the ffmpeg thread
                match ffmpeg_handle.join() {
                    Ok(result) => match result {
                        Ok(_) => println!("Recording stopped successfully."),
                        Err(e) => eprintln!("Recording thread encountered an error: {}", e),
                    },
                    Err(_) => eprintln!("Failed to join recording thread."),
                }
            }
        }

        // Reset the state to `Idle`
        let mut state_guard = self.state.lock().map_err(|_| "Failed to acquire state lock".to_string())?;
        *state_guard = RecordingState::Idle;

        // Lastly, reset the should_stop flag for potential next recording.
        self.should_stop.store(false, Ordering::SeqCst);

        Ok(())
    }

}