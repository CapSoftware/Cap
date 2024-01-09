use serde::{Serialize, Deserialize};

use crate::utils::run_command;
use crate::utils::ffmpeg_path_as_str;

#[derive(Debug, Serialize, Deserialize)]
pub struct DeviceList {
    video_devices: Vec<String>,
    audio_devices: Vec<String>,
}

#[tauri::command]
pub fn list_devices() -> Result<DeviceList, String> {
    let os_type = std::env::consts::OS;
    let ffmpeg_binary_path_str = ffmpeg_path_as_str()?;

    println!("OS: {}", os_type);
    println!("FFmpeg binary path: {}", ffmpeg_binary_path_str);

    match os_type {
        "macos" => {
            let (output, stderr) = run_command(&ffmpeg_binary_path_str, vec!["-f", "avfoundation", "-list_devices", "true", "-i", ""])?;
            let raw_output = if !stderr.trim().is_empty() { stderr } else { output };
            let (video_devices, audio_devices) = parse_devices_macos(&raw_output);

            println!("Video devices: {:?}", video_devices);
            println!("Audio devices: {:?}", audio_devices);

            Ok(DeviceList { video_devices, audio_devices })
        }
        "linux" => {
            let (raw_output, _) = run_command("v4l2-ctl", vec!["--list-devices"])?;
            let video_devices = raw_output.split('\n').map(|s| s.to_string()).collect();

            let (raw_output, _) = run_command("arecord", vec!["-l"])?;
            let audio_devices = raw_output.split('\n').map(|s| s.to_string()).collect();
            Ok(DeviceList { video_devices, audio_devices })
        }
        "windows" => {
            let (raw_output, _) = run_command(&ffmpeg_binary_path_str, vec!["-f", "dshow", "-list_devices", "true", "-i", ""])?;
            let (video_devices, audio_devices) = parse_devices_windows(&raw_output);
            Ok(DeviceList { video_devices, audio_devices })
        }
        _ => Err("Unsupported OS".to_string()),
    }
}

fn parse_devices_macos(raw_output: &str) -> (Vec<String>, Vec<String>) {
    let lines: Vec<&str> = raw_output.lines().collect();
    let video_start_index = lines.iter().position(|&x| x.contains("AVFoundation video devices:")).unwrap_or(0) + 1;
    let audio_start_index = lines.iter().position(|&x| x.contains("AVFoundation audio devices:")).unwrap_or(0) + 1;
    
    let video_devices = lines[video_start_index..audio_start_index-1]
        .iter()
        .filter_map(|&line| {
            if line.contains("]") {
                Some(line.split("]").last()?.trim().to_string())
            } else {
                None
            }
        })
        .collect();

    let audio_devices = lines[audio_start_index..]
        .iter()
        .filter_map(|&line| {
            if line.contains("]") {
                Some(line.split("]").last()?.trim().to_string())
            } else {
                None
            }
        })
        .collect();

    (video_devices, audio_devices)
}

fn parse_devices_windows(raw_output: &str) -> (Vec<String>, Vec<String>) {
    let lines: Vec<&str> = raw_output.lines().collect();
    let video_start_index = lines.iter().position(|&x| x.contains("DirectShow video devices")).unwrap_or(0) + 1;
    let audio_start_index = lines.iter().position(|&x| x.contains("DirectShow audio devices")).unwrap_or(0) + 1;
    
    let video_devices = lines[video_start_index..audio_start_index-1]
        .iter()
        .filter_map(|&line| {
            if line.contains("]") {
                Some(line.split("]").last()?.trim().to_string())
            } else {
                None
            }
        })
        .collect();

    let audio_devices = lines[audio_start_index..]
        .iter()
        .filter_map(|&line| {
            if line.contains("]") {
                Some(line.split("]").last()?.trim().to_string())
            } else {
                None
            }
        })
        .collect();

    (video_devices, audio_devices)
}
