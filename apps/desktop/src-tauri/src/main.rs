#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::sync::{Arc, Mutex};
use std::env;
use dotenv::dotenv;
use s3::bucket::Bucket;
use s3::creds::Credentials;
use s3::region::Region;
use s3::error::S3Error;
use uuid::Uuid;
use tauri::{Manager, Window};
use tauri_plugin_positioner::{WindowExt, Position};

use ffmpeg_sidecar::{
    command::ffmpeg_is_installed,
    download::{check_latest_version, download_ffmpeg_package, ffmpeg_download_url, unpack_ffmpeg},
    error::Result as FfmpegResult,
    paths::sidecar_dir,
    version::ffmpeg_version,
};

mod recorder;
use recorder::ScreenRecorder;

#[tauri::command]
fn start_screen_recording(window: Window, user_id: String, recorder: tauri::State<'_, Arc<Mutex<ScreenRecorder>>>) {
    let window = window.clone();
    let recorder = recorder.inner().clone();
    std::thread::spawn(move || {
        println!("Thread for recording started");
        match recorder.lock() {
            Ok(mut recorder) => {
                recorder.set_user_id(user_id);
                match recorder.start_recording() {
                    Ok(()) => println!("Recording started successfully"),
                    Err(e) => window.emit("recording-error", &e.to_string()).expect("Failed to send recording-error event."),
                }
            },
            Err(e) => window.emit("recording-error", &format!("Failed to lock recorder: {}", e)).expect("Failed to send recording-error event."),
        }
        println!("Thread for recording ended");
    });
}

#[tauri::command]
fn stop_screen_recording(recorder: tauri::State<'_, Arc<Mutex<ScreenRecorder>>>) {
    let recorder = recorder.lock().expect("Failed to lock recorder.");
    if let Err(e) = recorder.stop_recording() {
        eprintln!("Failed to stop recording: {}", e);
    }
}

async fn setup_s3_client() -> Result<Bucket, S3Error> {
    let access_key = env::var("CLOUDFLARE_ACCESS_KEY").expect("CLOUDFLARE_ACCESS_KEY not set");
    let secret_key = env::var("CLOUDFLARE_SECRET_KEY").expect("CLOUDFLARE_SECRET_KEY not set");
    let r2_endpoint = env::var("CLOUDFLARE_R2_ENDPOINT").expect("CLOUDFLARE_R2_ENDPOINT not set");

    let region = Region::Custom {
        region: "auto".to_string(),
        endpoint: r2_endpoint.to_string(), 
    };
    let credentials = Credentials::new(Some(&access_key), Some(&secret_key), None, None, None)?;
    let bucket = Bucket::new("caps", region, credentials)?;

    // Perform a simple health check operation, such as listing objects
    // Here we list the first object or prefix to minimize performance impact
    bucket.list("".to_string(), Some("/".to_string())).await.map_err(|e| e)?;
    
    Ok(bucket)
}

#[tauri::command]
async fn upload_video(window: Window, user_id: String, file_path: String) -> Result<String, String> {
    let window = window.clone();
    let bucket_result = setup_s3_client().await;
    
    if let Err(e) = bucket_result {
        return Err(format!("Failed to setup S3 client: {}", e));
    }

    let bucket = bucket_result.unwrap();
    
    // Generate a random UUID for the new folder name
    let video_folder_uuid = Uuid::new_v4().to_string();
    let file_name = file_path.split('/').last().ok_or("Invalid file path")?.to_string();
    
    // Update the file key to include the random UUID
    let file_key = format!("{}/{}/{}", user_id, video_folder_uuid, file_name);
    
    let content = match std::fs::read(&file_path) {
        Ok(data) => data,
        Err(e) => return Err(format!("Failed to read video file: {}", e)),
    };
    
    match bucket.put_object(&file_key, &content).await {
        Ok(data) => {
            if data.status_code() == 200 {
                window.emit("video-uploaded", &video_folder_uuid)
                    .expect("Failed to send the video-uploaded event");
                Ok(file_key)
            } else {
                let error_message = format!("Failed to upload file: HTTP Status Code {}", data.status_code());
                Err(error_message)
            }
        },
        Err(e) => return Err(format!("Failed to upload file: {}", e)),
    }
}

fn main() {
    dotenv().ok();

    std::panic::set_hook(Box::new(|info| {
        eprintln!("Thread panicked: {:?}", info);
    }));

    if which::which("ffmpeg").is_err() {
        if let Err(e) = handle_ffmpeg_installation() {
            eprintln!("Failed to handle FFmpeg installation: {}", e);
        }
    }

    fn handle_ffmpeg_installation() -> FfmpegResult<()> {
        if ffmpeg_is_installed() {
            println!("FFmpeg is already installed! 🎉");
            return Ok(());
        }

        match check_latest_version() {
            Ok(version) => println!("Latest available version: {}", version),
            Err(_) => println!("Skipping version check on this platform."),
        }

        let download_url = ffmpeg_download_url()?;
        let destination = sidecar_dir()?;

        println!("Downloading from: {:?}", download_url);
        let archive_path = download_ffmpeg_package(download_url, &destination)?;
        println!("Downloaded package: {:?}", archive_path);

        println!("Extracting...");
        unpack_ffmpeg(&archive_path, &destination)?;

        let version = ffmpeg_version()?;
        println!("FFmpeg version: {}", version);

        println!("Done! 🏁");
        Ok(())
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_positioner::init())
        .setup(|app| {  
            tauri::async_runtime::block_on(async {
                if let Err(e) = setup_s3_client().await {
                    eprintln!("S3 client health check failed: {}", e);
                    // Handle the error as needed, possibly exiting the application.
                    // std::process::exit(1);
                } else {
                    eprintln!("S3 client health check passed.");
                }
            });

            // Fetch the full path to the FFmpeg binary
            let ffmpeg_binary_path = sidecar_dir()?.join(if cfg!(target_os = "windows") { "ffmpeg.exe" } else { "ffmpeg" });

            let window = app.get_window("options").ok_or("Failed to get options window")?;
  
            // Create an instance of ScreenRecorder with the ffmpeg_binary_path
            let recorder = ScreenRecorder::new(
                ffmpeg_binary_path,
                window.clone()
            );
  
            let shared_recorder = Arc::new(Mutex::new(recorder));
            app.manage(shared_recorder);

            if let Some(camera_window) = app.get_window("camera") { 
              let _ = camera_window.move_window(Position::BottomRight);
            }

            if let Some(options_window) = app.get_window("options") { 
              let _ = options_window.move_window(Position::Center);
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            start_screen_recording,
            stop_screen_recording,
            upload_video
        ])
        .plugin(tauri_plugin_context_menu::init())
        .run(tauri::generate_context!())
        .expect("Error while running tauri application");
}