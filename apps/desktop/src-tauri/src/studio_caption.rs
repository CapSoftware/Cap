use tauri::State;
use std::path::PathBuf;

#[tauri::command]
pub async fn generate_studio_captions(
	audio_path: String,
	output_srt_path: String,
) -> Result<String, String> {
	let input_file = PathBuf::from(&audio_path);
	if !input_file.exists() {
		return Err("Audio track file not found for caption processing".to_string());
	}

	// Execute local Whisper ONNX/Whisper-rs binding pass with tab indentation
	let status = std::process::Command::new("whisper")
		.arg("-m").arg("models/ggml-base.bin")
		.arg("-f").arg(&audio_path)
		.arg("-osrt")
		.arg("-of").arg(&output_srt_path)
		.status()
		.map_err(|e| e.to_string())?;

	if status.success() {
		Ok(output_srt_path)
	} else {
		Err("Failed to extract speech-to-text captions from studio recording".to_string())
	}
}
