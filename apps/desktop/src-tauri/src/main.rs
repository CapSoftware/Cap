#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

extern crate scrap;

use scrap::{Capturer, Display};
use std::io::ErrorKind::WouldBlock;
use std::thread;
use std::time::Duration;
use std::path::Path;
use std::fs;
use tauri::Manager;
use image::{ImageBuffer, RgbaImage, Pixel, Rgba};

// Define a command that can be invoked from the frontend
#[tauri::command]
fn take_screenshot() -> Result<(), String> {
    let frames_dir = Path::new("frames");
    if let Err(e) = fs::create_dir_all(&frames_dir) {
        return Err(format!("Failed to create frames directory: {}", e));
    }

    let one_frame = Duration::from_nanos(16666667); // Approx. 1/60 second

    let display = Display::primary().map_err(|e| format!("Couldn't find primary display: {}", e))?;
    let mut capturer = Capturer::new(display).map_err(|e| format!("Couldn't begin capture: {}", e))?;
    let (w, h) = (capturer.width(), capturer.height());

    // Log width and height
    println!("Width: {}, Height: {}", w, h);

    // Attempt to capture a frame, retrying if needed
    let buffer = loop {
        match capturer.frame() {
            Ok(buffer) => break buffer,
            Err(error) if error.kind() == WouldBlock => {
                thread::sleep(one_frame);
                continue;
            },
            Err(e) => return Err(format!("Error capturing frame: {}", e)),
        }
    };

    println!("Captured! Processing...");

    // Convert BGRA to RGBA
    let mut rgba_buffer = Vec::with_capacity(buffer.len());
    for chunk in buffer.chunks_exact(4) {
        let bgra = [chunk[0], chunk[1], chunk[2], chunk[3]];
        let rgba = Rgba::from_channels(bgra[2], bgra[1], bgra[0], bgra[3]);
        rgba_buffer.extend_from_slice(&rgba.0);
    }

    // Attempt to create an RgbaImage from the converted buffer.
    let image: RgbaImage = ImageBuffer::from_vec(w as u32, h as u32, rgba_buffer)
        .ok_or_else(|| "Creating the image buffer failed".to_string())?;

    let scaled_width = (w as f32 * 0.5) as u32; // Reducing width to 50%
    let scaled_height = (h as f32 * 0.5) as u32; // Reducing height to 50%
    let resized_image = image::imageops::resize(
        &image,
        scaled_width,
        scaled_height,
        image::imageops::FilterType::Lanczos3, // High-quality filter
    );

    // Save the image
    let image_path = frames_dir.join("screenshot.png");
    resized_image.save(&image_path)
        .map_err(|e| format!("Failed to save screenshot: {}", e))?;

    println!("Image saved as `screenshot.png`.");
    Ok(())
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_context_menu::init()) // Ensure you have this plugin in your dependencies
        .invoke_handler(tauri::generate_handler![take_screenshot])
        .run(tauri::generate_context!())
        .expect("Failed to run Tauri application");
}