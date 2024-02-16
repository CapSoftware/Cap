use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::SampleFormat;
use std::process::{Stdio, Command};
use std::io::Write;
use byteorder::{ByteOrder, LittleEndian};
use std::sync::{Arc, Mutex};

use crate::recording::RecordingOptions;
use crate::utils::ffmpeg_path_as_str;

pub struct AudioRecorder {
    pub options: Option<RecordingOptions>,
    ffmpeg_stdin: Arc<Mutex<Option<std::process::ChildStdin>>>,
    device_name: Option<String>,
    stream: Option<cpal::Stream>,
}

impl AudioRecorder {

    pub fn new() -> Self {
        AudioRecorder {
            options: None,
            ffmpeg_stdin: Arc::new(Mutex::new(None)),
            device_name: None,
            stream: None,
        }
    }

    pub fn setup_recording(&mut self, options: RecordingOptions, audio_file_path: &str, custom_device: Option<&str>) -> Result<(), &'static str> {
        self.options = Some(options);
        
        let host = cpal::default_host();
        let devices = host.devices().expect("Failed to get devices");
        
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

        audio_filters.push("loudnorm");

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

        let stdin = child.stdin.take().expect("failed to get stdin");

        let err_fn = move |err| {
            eprintln!("an error occurred on stream: {}", err);
        };

        let ffmpeg_stdin_arc_clone = Arc::clone(&self.ffmpeg_stdin);
        
        let stream_result: Result<cpal::Stream, cpal::BuildStreamError> = match config.sample_format() {
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
        self.stream = Some(stream);
        *self.ffmpeg_stdin.lock().unwrap() = Some(stdin);
        self.device_name = Some(device.name().expect("Failed to get device name"));

        Ok(())
    }

    pub fn start_audio_recording(&mut self) -> Result<(), &'static str> {
        if let Some(ref mut stream) = self.stream {
            stream.play().map_err(|_| "Failed to play stream")?;
            println!("Started audio recording.");
        } else {
            println!("Audio recording was not started.");
        }

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