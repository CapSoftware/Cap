use std::io::{ErrorKind::WouldBlock, Write};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use std::path::{PathBuf, Path};
use std::fs;
use std::fs::File;
use std::sync::atomic::{AtomicBool, Ordering};
use scrap::{Capturer, Display};

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
}

const BYTES_PER_PIXEL: usize = 4;

impl ScreenRecorder {
  
    pub fn new(ffmpeg_path: PathBuf) -> Self {
        Self {
            state: Arc::new(Mutex::new(RecordingState::Idle)),
            ffmpeg_handle: Mutex::new(None),
            ffmpeg_path,
            should_stop: Arc::new(AtomicBool::new(false)),
        }
    }

    pub fn start_recording(&self) -> Result<(), String> {
        let state = self.state.clone();
        let should_stop = self.should_stop.clone();
        let ffmpeg_path = self.ffmpeg_path.clone();

        // Ensure we have a primary display to capture
        let display = Display::primary().map_err(|_| "Failed to find primary display".to_string())?;
        let (w, h) = (display.width(), display.height());
        let adjusted_height = h & !1;
        let capture_size = w * adjusted_height * BYTES_PER_PIXEL;
        let framerate = 30;

        // Check current recording state
        let mut state_guard = state.lock().map_err(|_| "Failed to acquire state lock".to_string())?;
        if *state_guard != RecordingState::Idle {
            return Err("Recording is already in progress".to_owned());
        }
        *state_guard = RecordingState::Recording;
        drop(state_guard);

        // Define paths for recordings and temp data
        let recordings_dir = Path::new("recordings");
        fs::create_dir_all(&recordings_dir).map_err(|e| format!("Failed to create recordings directory: {}", e))?;
        let tmp_file_path = recordings_dir.join("temporary_capture.raw");
        let output_path = recordings_dir.join("recording.mp4").to_owned();

        // Delete existing files if necessary
        if output_path.exists() {
            fs::remove_file(&output_path).map_err(|e| format!("Failed to delete existing recording file: {}", e))?;
        }
        let output_path_str = output_path.to_str().ok_or_else(|| "Failed to construct output file path string".to_string())?.to_owned();

        // Spawn the recording thread
       let ffmpeg_handle = thread::spawn(move || {
            // Start the capture session and open the temporary file
            let mut capturer = Capturer::new(display).expect("Failed to start capture");
            let mut raw_file = File::create(&tmp_file_path)
                .map_err(|e| format!("Failed to create temporary raw file: {}", e))?;

            let frame_duration = Duration::from_secs_f64(1.0 / framerate as f64);
            
            loop {
                // Start timing the frame capture
                let frame_start = Instant::now();

                // Stop the loop if the recording is set to be stopped
                if should_stop.load(Ordering::SeqCst) {
                    break;
                }

                // Capture a frame, handling potential errors
                let buffer = match capturer.frame() {
                    Ok(buffer) => buffer,
                    Err(error) if error.kind() == WouldBlock => {
                        // If capturing would block, wait a bit and retry
                        thread::sleep(Duration::from_micros(100));
                        continue;
                    },
                    Err(e) => return Err(format!("Error capturing frame: {}", e)),
                };

                let stride = buffer[..capture_size].len() / adjusted_height;

                for row in 0..adjusted_height {
                    let start = row * stride;
                    let end = start + stride;
                    if let Err(e) = raw_file.write_all(&buffer[start..end]) {
                        eprintln!("Failed to write frame: {:?}", e);
                        *state.lock().unwrap() = RecordingState::Stopping;
                        break;
                    }
                }

                // Calculate the time to sleep to maintain the target framerate
                let elapsed_time = frame_start.elapsed();
                if let Some(remaining_sleep_duration) = frame_duration.checked_sub(elapsed_time) {
                    thread::sleep(remaining_sleep_duration);
                }
            }
            // Close the temporary file to ensure all data is flushed
            drop(raw_file);

            // Start the encoding process using FFmpeg
            let status = Command::new(&ffmpeg_path)
                .args(&[
                    "-f", "rawvideo",
                    "-pix_fmt", "bgra",
                    "-s", &format!("{}x{}", w, adjusted_height),
                    "-r", &framerate.to_string(),
                    "-i", tmp_file_path.to_str().unwrap(),
                    "-c:v", "libx264",
                    "-preset", "veryfast",
                    "-crf", "15",
                    "-pix_fmt", "yuv420p",
                    "-y",
                    "-movflags", "+faststart",
                    &output_path_str,
                ])
                .output();

            // Handle the FFmpeg output
            match status {
                Ok(output) if output.status.success() => {
                    // Encoding succeeded, remove the temporary file
                    fs::remove_file(&tmp_file_path).map_err(|e| format!("Failed to remove temporary file: {}", e))?;
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