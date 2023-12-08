use std::io::{ErrorKind::WouldBlock, Write};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use std::path::{PathBuf, Path};
use std::fs;
use std::sync::atomic::{AtomicBool, Ordering};
use std::fs::File;
use scrap::{Capturer, Display};
use image::{ImageBuffer, RgbaImage, Pixel, Rgba};

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

fn save_frame_to_file(frame: &[u8], output_file_path: PathBuf) -> Result<(), std::io::Error> {
    let mut output_file = File::create(output_file_path)?;
    output_file.write_all(frame)?;
    Ok(())
}

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

        println!("Starting recording from function");
        println!("ffmpeg_path: {}", ffmpeg_path.to_str().unwrap());

        let display = Display::primary().map_err(|_| "Failed to find primary display".to_string())?;
        let (w, h) = (display.width(), display.height());
        let adjusted_height = h & !1;
        let capture_size = w * adjusted_height * BYTES_PER_PIXEL;
        let framerate = 60;
        let frame_duration = Duration::from_secs_f64(1.0 / framerate as f64);
        let mut last_frame_time = Instant::now();
        let one_frame_duration = Duration::from_secs_f64(1.0 / framerate as f64);
    
        println!("Display size: {}x{}", w, h);

        let mut state_guard = state.lock().map_err(|_| "Failed to acquire state lock".to_string())?;
        if *state_guard != RecordingState::Idle {
            return Err("Recording is already in progress".to_owned());
        }
        *state_guard = RecordingState::Recording;
        drop(state_guard); // Drop the lock as soon as it's no longer needed.

        let recordings_dir = Path::new("recordings");
        fs::create_dir_all(&recordings_dir).map_err(|e| format!("Failed to create recordings directory: {}", e))?;

        let output_path = recordings_dir.join("recording.mp4");
        let output_path_str = output_path.to_str().ok_or_else(|| "Failed to construct output file path string".to_string())?;

        println!("Output path: {}", output_path_str);
        println!("Starting FFmpeg...");

        let mut command = Command::new(&self.ffmpeg_path)
            .args(&[
                "-f", "rawvideo",            // Input format
                "-pix_fmt", "bgra",          // Input pixel format
                "-video_size", &format!("{}x{}", w, adjusted_height), // Input video size
                "-framerate", &framerate.to_string(),          // Input frame rate
                "-i", "-",                   // Input from stdin (use `pipe:0` if `-` does not work)
                "-c:v", "libx264",           // Video codec
                "-preset", "veryfast",       // Encoding preset
                "-crf", "18",                // Constant Rate Factor for quality
                "-pix_fmt", "yuv420p",       // Output pixel format
                "-y",                        // Overwrite output file without asking
                "-movflags", "+faststart",   // Enable fast start
                output_path_str,             // Output file path
            ])
            .stdin(Stdio::piped())
            .spawn()
            .map_err(|e| format!("Failed to start FFmpeg: {}", e))?;

        let ffmpeg_stdin = command.stdin.take().ok_or_else(|| "Failed to take FFmpeg stdin".to_string())?;

        println!("FFmpeg started");

        let should_stop_clone = should_stop.clone();
        let ffmpeg_handle = thread::spawn(move || {
            // Set up the capturer for the primary display.
            let mut capturer = Capturer::new(display).expect("Failed to start capture");
            let mut ffmpeg_stdin_guard = ffmpeg_stdin;

            // Create a new buffer for the frame with the exact size required, excluding any padding.
            let frame_size = w * h * BYTES_PER_PIXEL;
            
            // Capture frames in a loop.
            loop {
                let start_frame_time = Instant::now();
                if should_stop_clone.load(Ordering::SeqCst) {
                    *state.lock().unwrap() = RecordingState::Stopping;
                    break;
                }    
                let buffer = match capturer.frame() {
                    Ok(buffer) => buffer,
                    Err(error) if error.kind() == WouldBlock => {
                        thread::sleep(Duration::from_millis(1));
                        continue;
                    },
                    Err(e) => return Err(format!("Error capturing frame: {}", e)),
                };
                
                // argb_to_i420(w as usize, adjusted_height as usize, &buffer[..capture_size], &mut yuv_buffer);

                let stride = buffer[..capture_size].len() / adjusted_height;

                // Write each row of the buffer to FFmpeg, excluding stride if there is any.
                // Here we're assuming there's no stride, so we write the entire row.
                for row in 0..adjusted_height {
                    let start = row * stride;
                    let end = start + stride;
                    if let Err(e) = ffmpeg_stdin_guard.write_all(&buffer[start..end]) {
                        eprintln!("Failed to write to FFmpeg stdin: {:?}", e);
                        *state.lock().unwrap() = RecordingState::Stopping;
                        break;
                    }
                }

                // Flush FFmpeg's stdin to ensure all data is sent.
                if let Err(e) = ffmpeg_stdin_guard.flush() {
                    eprintln!("Failed to flush FFmpeg stdin: {:?}", e);
                    *state.lock().unwrap() = RecordingState::Stopping;
                }

                if let Some(time_to_sleep) = frame_duration.checked_sub(start_frame_time.elapsed()) {
                    thread::sleep(time_to_sleep);
                }
            };


            // Handle closing FFmpeg's stdin and waiting for the encoding process to finish.
            drop(ffmpeg_stdin_guard);
            let output_status = command.wait_with_output();
            match output_status {
                Ok(output) => {
                    if !output.stderr.is_empty() {
                        eprintln!("FFmpeg stderr: {}", String::from_utf8_lossy(&output.stderr));
                    }
                    if output.status.success() {
                        println!("FFmpeg encoding completed successfully.");
                        Ok(())
                    } else {
                        let error_message = format!("FFmpeg exited with error, status: {:?}", output.status.code());
                        eprintln!("{}", &error_message);
                        Err(error_message)
                    }
                },
                Err(e) => {
                    let error_message = format!("Failed to wait for FFmpeg child: {}", e);
                    eprintln!("{}", &error_message);
                    Err(error_message)
                },
            }
        });


        *self.ffmpeg_handle.lock().unwrap() = Some(ffmpeg_handle);

        Ok(())
    }


    pub fn stop_recording(&self) {
        println!("Stop recording requested.");
        
        // Mark the flag to stop recording
        self.should_stop.store(true, Ordering::SeqCst);

        let mut ffmpeg_handle_lock = match self.ffmpeg_handle.lock() {
            Ok(guard) => guard,
            Err(_) => {
                eprintln!("Failed to lock ffmpeg_handle mutex.");
                return;
            }
        };

        if let Some(ffmpeg_handle) = ffmpeg_handle_lock.take() {
            drop(ffmpeg_handle_lock); 
            match ffmpeg_handle.join() {
                Ok(result) => match result {
                    Ok(_) => println!("Recording stopped successfully."),
                    Err(e) => eprintln!("Recording thread encountered an error: {}", e),
                },
                Err(_) => eprintln!("Failed to join recording thread."),
            };
        } else {
            println!("Recording was not in progress or is already stopping.");
        }

        // Lastly, reset the should_stop flag for potential next recording.
        self.should_stop.store(false, Ordering::SeqCst);
    }
}