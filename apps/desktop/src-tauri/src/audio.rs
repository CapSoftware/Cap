use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::SampleFormat;
use std::io::{BufReader, BufRead};
use std::process::{Stdio, Command};
use std::thread;
use std::io::Write;
use byteorder::{ByteOrder, LittleEndian};
use std::sync::{Arc, Mutex};

use crate::recording::RecordingOptions;
use crate::utils::ffmpeg_path_as_str;

pub struct AudioRecorder {
    pub options: Option<RecordingOptions>,
    ffmpeg_stdin: Arc<Mutex<Option<std::process::ChildStdin>>>,
    stream: Option<cpal::Stream>,
}

impl AudioRecorder {

    pub fn new() -> Self {
        AudioRecorder {
            options: None,
            ffmpeg_stdin: Arc::new(Mutex::new(None)),
            stream: None,
        }
    }

    pub fn setup_recording(&mut self, options: RecordingOptions, audio_file_path: &str) {
        self.options = Some(options);
        
        let host = cpal::default_host();
        let device = host.default_input_device().expect("No input device available");
        let config = device.default_input_config().expect("Failed to get default input config");
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
        println!("Audio file path: {}", audio_file_path);
        
        let ffmpeg_binary_path_str = ffmpeg_path_as_str().unwrap().to_owned();
        let audio_file_path_owned = audio_file_path.to_owned();
        let sample_rate_str = sample_rate.to_string();
        let channels_str = channels.to_string();

        println!("Starting audio recording and processing...");
        let output_chunk_pattern = format!("{}/audio_recording_%03d.aac", audio_file_path_owned);
        let segment_list_filename = format!("{}/segment_list.txt", audio_file_path_owned);
      
        let mut audio_filters = Vec::new();

        if channels > 2 {
            audio_filters.push("pan=stereo|FL=FL+0.5*FC|FR=FR+0.5*FC");
        }

        // Add loudnorm and acompressor to the filter chain
        audio_filters.push("loudnorm");
        audio_filters.push("acompressor");

        let audio_filters_str = audio_filters.join(",");

        let ffmpeg_command = vec![
            "-f", sample_format,
            "-ar", &sample_rate_str,
            "-ac", &channels_str,
            "-i", "-",
            "-c:a", "aac",
            "-b:a", "128k",
            "-af", &audio_filters_str,
            "-f", "segment",
            "-segment_time", "3",
            "-segment_list", &segment_list_filename,
            &output_chunk_pattern,
        ];

        let mut child = Command::new(&ffmpeg_binary_path_str)
            .args(&ffmpeg_command)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("ffmpeg command failed to start");

        thread::spawn(move || {
            let stdout = BufReader::new(child.stdout.take().expect("failed to get stdout"));
            for line in stdout.lines() {
                match line {
                    Ok(line) => eprintln!("Audio stdout: {}", line),
                    Err(e) => eprintln!("Error reading FFmpeg stdout: {}", e),
                }
            }
        });

        thread::spawn(move || {
            let stderr = BufReader::new(child.stderr.take().expect("failed to get stderr"));
            for line in stderr.lines() {
                match line {
                    Ok(line) => eprintln!("Audio stderr: {}", line),
                    Err(e) => eprintln!("Error reading FFmpeg stderr: {}", e),
                }
            }
        });
            
        let stdin = child.stdin.take().expect("failed to get stdin");
        *self.ffmpeg_stdin.lock().unwrap() = Some(stdin);

        self.start_audio_recording().expect("Failed to start audio recording");
    }

    pub fn start_audio_recording(&mut self) -> Result<(), &'static str> {
        let host = cpal::default_host();
        let device = host.default_input_device().ok_or("Unable to find default input device")?;
        let config: cpal::SupportedStreamConfig = device
            .default_input_config()
            .expect("Failed to get default input config");
        println!("Default input config: {:?}", config);     
        let sample_format = config.sample_format();

        println!("Starting audio recording with sample format: {:?}", sample_format);

        let err_fn = move |err| {
            eprintln!("an error occurred on stream: {}", err);
        };

        let ffmpeg_stdin_arc_clone = Arc::clone(&self.ffmpeg_stdin);
        
      let stream_result: Result<cpal::Stream, cpal::BuildStreamError> = match sample_format {
          SampleFormat::I8 => device.build_input_stream(
              &config.into(),
              move |data: &[i8], _: &_| {
                let mut ffmpeg_stdin_lock = ffmpeg_stdin_arc_clone.lock().unwrap();
                if let Some(ref mut stdin) = *ffmpeg_stdin_lock {
                    let bytes = data.iter().map(|&sample| sample as u8).collect::<Vec<u8>>();
                    let _ = stdin.write_all(&bytes);
                    let _ = stdin.flush();
                }
              },
              err_fn,
              None,
          ),
          SampleFormat::I16 => device.build_input_stream(
              &config.into(),
              move |data: &[i16], _: &_| {
                let mut ffmpeg_stdin_lock = ffmpeg_stdin_arc_clone.lock().unwrap();
                if let Some(ref mut stdin) = *ffmpeg_stdin_lock {
                    let mut bytes = vec![0; data.len() * 2];
                    LittleEndian::write_i16_into(data, &mut bytes);
                    let _ = stdin.write_all(&bytes);
                    let _ = stdin.flush();
                }
              },
              err_fn,
              None,
          ),
          SampleFormat::I32 => device.build_input_stream(
              &config.into(),
              move |data: &[i32], _: &_| {
                let mut ffmpeg_stdin_lock = ffmpeg_stdin_arc_clone.lock().unwrap();
                if let Some(ref mut stdin) = *ffmpeg_stdin_lock {
                    let mut bytes = vec![0; data.len() * 4];
                    LittleEndian::write_i32_into(data, &mut bytes);
                    let _ = stdin.write_all(&bytes);
                    let _ = stdin.flush();
                }
              },
              err_fn,
              None, 
          ),
          SampleFormat::F32 => device.build_input_stream(
              &config.into(),
              move |data: &[f32], _: &_| {
                  let mut ffmpeg_stdin_lock = ffmpeg_stdin_arc_clone.lock().unwrap();
                  if let Some(ref mut stdin) = *ffmpeg_stdin_lock {
                      let bytes = bytemuck::cast_slice::<f32, u8>(data);
                      if let Err(e) = stdin.write_all(bytes) {
                          eprintln!("Failed to write data to FFmpeg stdin: {}", e);
                      }
                  }
              },
              err_fn,
              None,
          ),
          _sample_format => Err(cpal::BuildStreamError::DeviceNotAvailable),
        };

        let stream = stream_result.map_err(|_| "Failed to build input stream")?;
        stream.play().map_err(|_| "Failed to play stream")?;

        self.stream = Some(stream);

        Ok(())
    }

    pub fn stop_audio_recording(&mut self) -> Result<(), &'static str> {
        if let Some(ref mut stream) = self.stream {
            stream.pause().map_err(|_| "Failed to pause stream")?;
            println!("Stopped audio recording.");
        } else {
            return Err("Recording was not started");
        }

        let mut ffmpeg_stdin_opt = self.ffmpeg_stdin.lock().map_err(|_| "Failed to acquire lock on ffmpeg stdin")?;
        
        if ffmpeg_stdin_opt.is_some() {
            *ffmpeg_stdin_opt = None;
            println!("Stopped audio recording and signaled FFmpeg to terminate.");
        } else {
            return Err("Recording was not started or FFmpeg stdin was already closed");
        }
        
        Ok(())
    }
}

