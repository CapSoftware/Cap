use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::SampleFormat;
use std::process::{Stdio};
use byteorder::{ByteOrder, LittleEndian};
use std::sync::{Arc};

use tokio::io::{AsyncWriteExt};
use tokio::process::{Command, ChildStdin};
use tokio::sync::{mpsc, Mutex};

use crate::recording::RecordingOptions;
use crate::utils::{ffmpeg_path_as_str, monitor_and_log_recording_start};

pub struct AudioRecorder {
    pub options: Option<RecordingOptions>,
    ffmpeg_process: Option<tokio::process::Child>,
    ffmpeg_stdin: Option<Arc<Mutex<ChildStdin>>>,
    device_name: Option<String>,
    stream: Option<cpal::Stream>,
    audio_channel_sender: Option<mpsc::Sender<Vec<u8>>>,
}

impl AudioRecorder {

    pub fn new() -> Self {
        AudioRecorder {
            options: None,
            ffmpeg_process: None,
            ffmpeg_stdin: None,
            device_name: None,
            stream: None,
            audio_channel_sender: None,
        }
    }

    pub async fn start_audio_recording(&mut self, options: RecordingOptions, audio_file_path: &str, custom_device: Option<&str>) -> Result<(), String> {
        self.options = Some(options);
        
        let host = cpal::default_host();
        let devices = host.devices().expect("Failed to get devices");
        let (tx, mut rx) = tokio::sync::mpsc::channel::<Vec<u8>>(32);
        let tx_clone = tx.clone();
        self.audio_channel_sender = Some(tx);
        
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

        let ffmpeg_command: Vec<String> = vec![
            "-f", sample_format,
            "-ar", &sample_rate_str,
            "-ac", &channels_str,
            "-i", "pipe:0",
            "-c:a", "aac",
            "-b:a", "128k",
            "-af", &audio_filters_str,
            "-f", "segment",
            "-segment_time", "3",
            "-segment_list", &segment_list_filename,
            "-reset_timestamps", "1",
            "-use_wallclock_as_timestamps", "1",
            "-fflags", "nobuffer",
            "-flags", "low_delay",
            "-strict", "experimental",
            &output_chunk_pattern,
        ].into_iter().map(|s| s.to_string()).collect();

        let video_id = self.options.as_ref().unwrap().video_id.clone();

        let mut child = start_audio_recording_process(&ffmpeg_binary_path_str, &video_id, &ffmpeg_command)
            .await
            .map_err(|e| e.to_string())?;

        let stdin = child.stdin.take().expect("failed to take child stdin");
        let stdin_arc = Arc::new(Mutex::new(stdin));
        let stdin_clone = Arc::clone(&stdin_arc);
        let stdin_global = Arc::clone(&stdin_arc);

        tokio::spawn(async move {
            while let Some(bytes) = rx.recv().await {
                let mut stdin_guard = stdin_clone.lock().await;
                if stdin_guard.write_all(&bytes).await.is_err() {
                    eprintln!("Failed to write to FFmpeg stdin");
                    break;
                }
            }
        });

        let err_fn = move |err| {
            eprintln!("an error occurred on stream: {}", err);
        };
        
        let stream_result: Result<cpal::Stream, cpal::BuildStreamError> = match config.sample_format() {
          SampleFormat::I8 => device.build_input_stream(
              &config.into(),
              move |data: &[i8], _: &_| {
                  let bytes = data.iter().map(|&sample| sample as u8).collect::<Vec<u8>>();
                  if tx_clone.try_send(bytes).is_err() {
                      eprintln!("Channel send error. Dropping data.");
                  }
              },
              err_fn,
              None,
          ),
          SampleFormat::I16 => device.build_input_stream(
              &config.into(),
              move |data: &[i16], _: &_| {
                  let mut bytes = vec![0; data.len() * 2];
                  LittleEndian::write_i16_into(data, &mut bytes);
                  if tx_clone.try_send(bytes).is_err() {
                      eprintln!("Channel send error. Dropping data.");
                  }
              },
              err_fn,
              None,
          ),
          SampleFormat::I32 => device.build_input_stream(
              &config.into(),
              move |data: &[i32], _: &_| {
                  let mut bytes = vec![0; data.len() * 4];
                  LittleEndian::write_i32_into(data, &mut bytes);
                  if tx_clone.try_send(bytes).is_err() {
                      eprintln!("Channel send error. Dropping data.");
                  }
              },
              err_fn,
              None, 
          ),
          SampleFormat::F32 => device.build_input_stream(
              &config.into(),
              move |data: &[f32], _: &_| {
                  let bytes = bytemuck::cast_slice::<f32, u8>(data).to_vec();
                  if tx_clone.try_send(bytes).is_err() {
                      eprintln!("Channel send error. Dropping data.");
                  }
              },
              err_fn,
              None,
          ),
          _sample_format => Err(cpal::BuildStreamError::DeviceNotAvailable),
        };

        let stream = stream_result.map_err(|_| "Failed to build input stream")?;

        self.stream = Some(stream);
        self.ffmpeg_process = Some(child);
        self.ffmpeg_stdin = Some(stdin_global);
        self.device_name = Some(device.name().expect("Failed to get device name"));
        
        self.trigger_play()?;

        Ok(())
    }

    pub fn trigger_play (&mut self) -> Result<(), &'static str> {
        if let Some(ref mut stream) = self.stream {
            stream.play().map_err(|_| "Failed to play stream")?;
            println!("Audio recording playing.");
        } else {
            return Err("Recording was not started");
        }

        Ok(())
    }

    pub async fn stop_audio_recording(&mut self) -> Result<(), String> {
        if let Some(sender) = self.audio_channel_sender.take() {
            drop(sender);
        }

        if let Some(ref mut stream) = self.stream {
            stream.pause().map_err(|_| "Failed to pause stream")?;
            println!("Audio recording paused.");
        } else {
            return Err("Recording was not started".to_string());
        }

        println!("Sending quit command to FFmpeg...");
        if let Some(stdin_arc) = self.ffmpeg_stdin.take() {
            let mut stdin_guard = stdin_arc.lock().await;
            if let Err(e) = stdin_guard.write_all(b"q\n").await {
                eprintln!("Failed to send quit command to FFmpeg: {}", e);
                return Err("Failed to send quit command to FFmpeg".to_string());
            }

            stdin_guard.flush().await.expect("Failed to flush FFmpeg stdin");

            println!("Quit command sent to FFmpeg. Waiting for FFmpeg to process...");

            tokio::time::sleep(std::time::Duration::from_millis(500)).await;

            println!("Finalizing FFmpeg process...");
        }

        println!("Audio recording stopped.");
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

async fn start_audio_recording_process(ffmpeg_binary_path_str: &str, video_id: &str, audio_args: &[String]) -> Result<(tokio::process::Child), std::io::Error> {
    let mut child = Command::new(ffmpeg_binary_path_str)
        .args(audio_args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;
    
    let stderr = child.stderr.take().expect("failed to take child stdout");

    let video_id_owned = video_id.to_owned();

    tokio::spawn(async move {
        if let Err(e) = monitor_and_log_recording_start(stderr, &video_id_owned, "audio").await {
            eprintln!("Failed to monitor and log audio recording start: {}", e);
        }
    });

    Ok(child)
}