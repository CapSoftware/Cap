use anyhow::Result;
use cap_audio::AudioData;
use ffmpeg::{
    ChannelLayout, codec as avcodec,
    format::{self as avformat},
    software::resampling,
};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::fs::File;
use std::io::Read;
use std::path::PathBuf;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager, Window};
use tempfile::tempdir;
use tokio::io::AsyncWriteExt;
use tokio::sync::Mutex;
use tracing::instrument;
use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters};

// Re-export caption types from cap_project
pub use cap_project::{CaptionSegment, CaptionSettings};

use crate::http_client;

// Convert the project type's float precision from f32 to f64 for compatibility
#[derive(Debug, Serialize, Deserialize, Type, Clone)]
pub struct CaptionData {
    pub segments: Vec<CaptionSegment>,
    pub settings: Option<CaptionSettings>,
}

impl Default for CaptionData {
    fn default() -> Self {
        Self {
            segments: Vec::new(),
            settings: Some(CaptionSettings::default()),
        }
    }
}

// Model context is shared and cached
lazy_static::lazy_static! {
    static ref WHISPER_CONTEXT: Arc<Mutex<Option<WhisperContext>>> = Arc::new(Mutex::new(None));
}

// Constants
const WHISPER_SAMPLE_RATE: u32 = 16000;

/// Function to handle creating directories for the model
#[tauri::command]
#[specta::specta]
#[instrument]
pub async fn create_dir(path: String, _recursive: bool) -> Result<(), String> {
    std::fs::create_dir_all(path).map_err(|e| format!("Failed to create directory: {e}"))
}

/// Function to save the model file
#[tauri::command]
#[specta::specta]
#[instrument]
pub async fn save_model_file(path: String, data: Vec<u8>) -> Result<(), String> {
    std::fs::write(&path, &data).map_err(|e| format!("Failed to write model file: {e}"))
}

/// Extract audio from a video file and save it as a temporary WAV file
async fn extract_audio_from_video(video_path: &str, output_path: &PathBuf) -> Result<(), String> {
    log::info!("Attempting to extract audio from: {video_path}");

    // Check if this is a .cap directory
    if video_path.ends_with(".cap") {
        log::info!("Detected .cap project directory");

        // Read the recording metadata
        let meta_path = std::path::Path::new(video_path).join("recording-meta.json");
        let meta_content = std::fs::read_to_string(&meta_path)
            .map_err(|e| format!("Failed to read recording metadata: {e}"))?;

        let meta: serde_json::Value = serde_json::from_str(&meta_content)
            .map_err(|e| format!("Failed to parse recording metadata: {e}"))?;

        // Get paths for both audio sources
        let base_path = std::path::Path::new(video_path);
        let mut audio_sources = Vec::new();

        if let Some(segments) = meta["segments"].as_array() {
            for segment in segments {
                // Add system audio if available
                if let Some(system_audio) = segment["system_audio"]["path"].as_str() {
                    audio_sources.push(base_path.join(system_audio));
                }

                // Add microphone audio if available
                if let Some(audio) = segment["audio"]["path"].as_str() {
                    audio_sources.push(base_path.join(audio));
                }
            }
        }

        if audio_sources.is_empty() {
            return Err("No audio sources found in the recording metadata".to_string());
        }

        log::info!("Found {} audio sources", audio_sources.len());

        // Process each audio source using AudioData
        let mut mixed_samples = Vec::new();
        let mut channel_count = 0;

        for source in audio_sources {
            match AudioData::from_file(&source) {
                Ok(audio) => {
                    log::info!(
                        "Processing audio source {:?}: {} channels, {} samples",
                        source,
                        audio.channels(),
                        audio.sample_count()
                    );

                    if mixed_samples.is_empty() {
                        mixed_samples = audio.samples().to_vec();
                        channel_count = audio.channels() as usize;
                    } else {
                        // Handle potential different channel counts by mixing to mono first if needed
                        if audio.channels() as usize != channel_count {
                            log::info!(
                                "Channel count mismatch: {} vs {}, mixing to mono",
                                channel_count,
                                audio.channels()
                            );

                            // If we have mixed samples with multiple channels, convert to mono
                            if channel_count > 1 {
                                let mono_samples = convert_to_mono(&mixed_samples, channel_count);
                                mixed_samples = mono_samples;
                                channel_count = 1;
                            }

                            // Convert the new audio to mono too if it has multiple channels
                            let samples = if audio.channels() > 1 {
                                convert_to_mono(audio.samples(), audio.channels() as usize)
                            } else {
                                audio.samples().to_vec()
                            };

                            // Mix mono samples
                            mix_samples(&mut mixed_samples, &samples);
                        } else {
                            // Same channel count, simple mix
                            mix_samples(&mut mixed_samples, audio.samples());
                        }
                    }
                }
                Err(e) => {
                    log::warn!("Failed to process audio source {source:?}: {e}");
                    continue;
                }
            }
        }

        // No matter what, ensure we have mono audio for Whisper
        if channel_count > 1 {
            log::info!("Converting final mixed audio from {channel_count} channels to mono");
            mixed_samples = convert_to_mono(&mixed_samples, channel_count);
            channel_count = 1;
        }

        if mixed_samples.is_empty() {
            return Err("Failed to process any audio sources".to_string());
        }

        // Convert to WAV format with desired sample rate
        let mut output = avformat::output(&output_path)
            .map_err(|e| format!("Failed to create output file: {e}"))?;

        let codec = avcodec::encoder::find_by_name("pcm_s16le")
            .ok_or_else(|| "PCM encoder not found".to_string())?;

        let mut encoder = avcodec::Context::new()
            .encoder()
            .audio()
            .map_err(|e| format!("Failed to create encoder: {e}"))?;

        encoder.set_rate(WHISPER_SAMPLE_RATE as i32);
        let channel_layout = ChannelLayout::MONO;
        encoder.set_channel_layout(channel_layout);
        encoder.set_format(avformat::Sample::I16(avformat::sample::Type::Packed));

        let mut encoder = encoder
            .open_as(codec)
            .map_err(|e| format!("Failed to open encoder: {e}"))?;

        let mut stream = output
            .add_stream(codec)
            .map_err(|e| format!("Failed to add stream: {e}"))?;
        stream.set_parameters(&encoder);

        output
            .write_header()
            .map_err(|e| format!("Failed to write header: {e}"))?;

        // Create resampler for sample rate conversion
        let mut resampler = resampling::Context::get(
            avformat::Sample::F32(avformat::sample::Type::Packed),
            channel_layout,
            AudioData::SAMPLE_RATE,
            avformat::Sample::I16(avformat::sample::Type::Packed),
            channel_layout,
            WHISPER_SAMPLE_RATE,
        )
        .map_err(|e| format!("Failed to create resampler: {e}"))?;

        // Process audio in chunks
        let frame_size = encoder.frame_size() as usize;
        // Check if frame_size is zero and use a fallback
        let frame_size = if frame_size == 0 { 1024 } else { frame_size };

        log::info!(
            "Using frame size: {}, total samples: {}, channel count: {}",
            frame_size,
            mixed_samples.len(),
            channel_count
        );

        let mut frame = ffmpeg::frame::Audio::new(
            avformat::Sample::I16(avformat::sample::Type::Packed),
            frame_size,
            ChannelLayout::MONO,
        );
        frame.set_rate(WHISPER_SAMPLE_RATE);

        // Make sure we have samples and a valid chunk size
        if !mixed_samples.is_empty() && frame_size * channel_count > 0 {
            // Process chunks of audio
            for (chunk_idx, chunk) in mixed_samples.chunks(frame_size * channel_count).enumerate() {
                if chunk_idx % 100 == 0 {
                    log::info!("Processing chunk {}, size: {}", chunk_idx, chunk.len());
                }

                // Create a new input frame with actual data from the chunk
                let mut input_frame = ffmpeg::frame::Audio::new(
                    avformat::Sample::F32(avformat::sample::Type::Packed),
                    chunk.len() / channel_count,
                    channel_layout,
                );
                input_frame.set_rate(AudioData::SAMPLE_RATE);

                // Copy data from chunk to frame
                let bytes = unsafe {
                    std::slice::from_raw_parts(
                        chunk.as_ptr() as *const u8,
                        std::mem::size_of_val(chunk),
                    )
                };
                input_frame.data_mut(0)[0..bytes.len()].copy_from_slice(bytes);

                // Create output frame for resampled data
                let mut output_frame = ffmpeg::frame::Audio::new(
                    avformat::Sample::I16(avformat::sample::Type::Packed),
                    frame_size,
                    ChannelLayout::MONO,
                );
                output_frame.set_rate(WHISPER_SAMPLE_RATE);

                // Use the input frame with actual data instead of the empty frame
                match resampler.run(&input_frame, &mut output_frame) {
                    Ok(_) => {
                        if chunk_idx % 100 == 0 {
                            log::info!(
                                "Successfully resampled chunk {}, output samples: {}",
                                chunk_idx,
                                output_frame.samples()
                            );
                        }
                    }
                    Err(e) => {
                        log::error!("Failed to resample chunk {chunk_idx}: {e}");
                        continue;
                    }
                }

                if let Err(e) = encoder.send_frame(&output_frame) {
                    log::error!("Failed to send frame to encoder: {e}");
                    continue;
                }

                // Process each encoded packet
                loop {
                    let mut packet = ffmpeg::Packet::empty();
                    match encoder.receive_packet(&mut packet) {
                        Ok(_) => {
                            if let Err(e) = packet.write_interleaved(&mut output) {
                                log::error!("Failed to write packet: {e}");
                            }
                        }
                        Err(_) => break,
                    }
                }
            }
        }

        // Flush the encoder
        encoder
            .send_eof()
            .map_err(|e| format!("Failed to send EOF: {e}"))?;

        // Process final packets in a loop with limited borrow scope
        loop {
            let mut packet = ffmpeg::Packet::empty();
            let received = encoder.receive_packet(&mut packet);

            if received.is_err() {
                break;
            }

            // Use a block to limit the scope of the output borrow
            {
                if let Err(e) = packet.write_interleaved(&mut output) {
                    return Err(format!("Failed to write final packet: {e}"));
                }
            }
        }

        output
            .write_trailer()
            .map_err(|e| format!("Failed to write trailer: {e}"))?;

        Ok(())
    } else {
        // Handle regular video file
        let mut input =
            avformat::input(&video_path).map_err(|e| format!("Failed to open video file: {e}"))?;

        let stream = input
            .streams()
            .best(ffmpeg::media::Type::Audio)
            .ok_or_else(|| "No audio stream found".to_string())?;

        let codec_params = stream.parameters();

        // Get decoder parameters first
        let decoder_ctx = avcodec::Context::from_parameters(codec_params.clone())
            .map_err(|e| format!("Failed to create decoder context: {e}"))?;

        // Create and open the decoder
        let mut decoder = decoder_ctx
            .decoder()
            .audio()
            .map_err(|e| format!("Failed to create decoder: {e}"))?;

        // Now we can access audio-specific methods
        let decoder_format = decoder.format();
        let decoder_channel_layout = decoder.channel_layout();
        let decoder_rate = decoder.rate();

        // Set up and prepare encoder and output separately to avoid multiple borrows
        let channel_layout = ChannelLayout::MONO;

        // Create encoder first
        let mut encoder_ctx = avcodec::Context::new()
            .encoder()
            .audio()
            .map_err(|e| format!("Failed to create encoder: {e}"))?;

        encoder_ctx.set_rate(WHISPER_SAMPLE_RATE as i32);
        encoder_ctx.set_channel_layout(channel_layout);
        encoder_ctx.set_format(avformat::Sample::I16(avformat::sample::Type::Packed));

        let codec = avcodec::encoder::find_by_name("pcm_s16le")
            .ok_or_else(|| "PCM encoder not found".to_string())?;

        let mut encoder = encoder_ctx
            .open_as(codec)
            .map_err(|e| format!("Failed to open encoder: {e}"))?;

        // Create output context separately
        let mut output = avformat::output(&output_path)
            .map_err(|e| format!("Failed to create output file: {e}"))?;

        // Add stream and get parameters in a block to limit the borrow
        let stream_params = {
            let mut output_stream = output
                .add_stream(codec)
                .map_err(|e| format!("Failed to add stream: {e}"))?;

            output_stream.set_parameters(&encoder);

            // Store the stream parameters we need for later
            (output_stream.index(), output_stream.id())
        };

        // Write header
        output
            .write_header()
            .map_err(|e| format!("Failed to write header: {e}"))?;

        // Create resampler
        let mut resampler = resampling::Context::get(
            decoder_format,
            decoder_channel_layout,
            decoder_rate,
            avformat::Sample::I16(avformat::sample::Type::Packed),
            channel_layout,
            WHISPER_SAMPLE_RATE,
        )
        .map_err(|e| format!("Failed to create resampler: {e}"))?;

        // Create frames
        let mut decoded_frame = ffmpeg::frame::Audio::empty();
        let mut resampled_frame = ffmpeg::frame::Audio::new(
            avformat::Sample::I16(avformat::sample::Type::Packed),
            encoder.frame_size() as usize,
            channel_layout,
        );

        // Save the stream index from the original stream (not the output stream)
        let input_stream_index = stream.index();

        // Process packets one at a time, cloning what we need from input packets
        let mut packet_queue = Vec::new();

        // First collect all the packets we need by cloning the data
        {
            // Use a separate block to limit the immutable borrow lifetime
            for (stream_idx, packet) in input.packets() {
                if stream_idx.index() == input_stream_index {
                    // Clone the packet data to avoid borrowing input
                    if let Some(data) = packet.data() {
                        // Copy the packet data to a new packet
                        let mut cloned_packet = ffmpeg::Packet::copy(data);
                        // Copy timing information
                        if let Some(pts) = packet.pts() {
                            cloned_packet.set_pts(Some(pts));
                        }
                        if let Some(dts) = packet.dts() {
                            cloned_packet.set_dts(Some(dts));
                        }
                        packet_queue.push(cloned_packet);
                    }
                }
            }
        }

        // Then process each cloned packet
        for packet_res in packet_queue {
            if let Err(e) = decoder.send_packet(&packet_res) {
                log::warn!("Failed to send packet to decoder: {e}");
                continue;
            }

            // Process decoded frames
            while decoder.receive_frame(&mut decoded_frame).is_ok() {
                if let Err(e) = resampler.run(&decoded_frame, &mut resampled_frame) {
                    log::warn!("Failed to resample audio: {e}");
                    continue;
                }

                if let Err(e) = encoder.send_frame(&resampled_frame) {
                    log::warn!("Failed to send frame to encoder: {e}");
                    continue;
                }

                // Process encoded packets
                loop {
                    let mut packet = ffmpeg::Packet::empty();
                    match encoder.receive_packet(&mut packet) {
                        Ok(_) => {
                            // Set the stream for the output packet
                            packet.set_stream(stream_params.0);

                            if let Err(e) = packet.write_interleaved(&mut output) {
                                log::error!("Failed to write packet: {e}");
                            }
                        }
                        Err(_) => break,
                    }
                }
            }
        }

        // Flush the decoder
        decoder
            .send_eof()
            .map_err(|e| format!("Failed to send EOF to decoder: {e}"))?;

        while decoder.receive_frame(&mut decoded_frame).is_ok() {
            resampler
                .run(&decoded_frame, &mut resampled_frame)
                .map_err(|e| format!("Failed to resample final audio: {e}"))?;

            encoder
                .send_frame(&resampled_frame)
                .map_err(|e| format!("Failed to send final frame: {e}"))?;

            // Process final encoded packets
            loop {
                let mut packet = ffmpeg::Packet::empty();
                let received = encoder.receive_packet(&mut packet);

                if received.is_err() {
                    break;
                }

                packet
                    .write_interleaved(&mut output)
                    .map_err(|e| format!("Failed to write final packet: {e}"))?;
            }
        }

        // Close the output file with trailer
        output
            .write_trailer()
            .map_err(|e| format!("Failed to write trailer: {e}"))?;

        Ok(())
    }
}

/// Load or initialize the WhisperContext
async fn get_whisper_context(model_path: &str) -> Result<Arc<WhisperContext>, String> {
    let mut context_guard = WHISPER_CONTEXT.lock().await;

    // Always create a new context to avoid issues with multiple uses
    log::info!("Initializing Whisper context with model: {model_path}");
    let ctx = WhisperContext::new_with_params(model_path, WhisperContextParameters::default())
        .map_err(|e| format!("Failed to load Whisper model: {e}"))?;

    *context_guard = Some(ctx);

    // Get a reference to the context and wrap it in an Arc
    let context_ref = context_guard.as_ref().unwrap();
    let context_arc = unsafe { Arc::new(std::ptr::read(context_ref)) };
    Ok(context_arc)
}

/// Process audio file with Whisper for transcription
fn process_with_whisper(
    audio_path: &PathBuf,
    context: Arc<WhisperContext>,
    language: &str,
) -> Result<CaptionData, String> {
    log::info!("Processing audio file: {audio_path:?}");

    // Set up parameters for Whisper
    let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });

    // Configure parameters for better caption quality
    params.set_translate(false);
    params.set_print_special(false);
    params.set_print_progress(false);
    params.set_print_realtime(false);
    params.set_token_timestamps(true); // Enable timestamps for captions
    params.set_language(Some(if language == "auto" { "auto" } else { language })); // Use selected language or auto-detect
    params.set_max_len(i32::MAX); // No max length for transcription

    // Load audio file
    let mut audio_file = File::open(audio_path)
        .map_err(|e| format!("Failed to open audio file: {e} at path: {audio_path:?}"))?;
    let mut audio_data = Vec::new();
    audio_file
        .read_to_end(&mut audio_data)
        .map_err(|e| format!("Failed to read audio file: {e}"))?;

    log::info!("Processing audio file of size: {} bytes", audio_data.len());

    // Convert audio data to the required format (16-bit mono PCM)
    let mut audio_data_f32 = Vec::new();
    for i in (0..audio_data.len()).step_by(2) {
        if i + 1 < audio_data.len() {
            let sample = i16::from_le_bytes([audio_data[i], audio_data[i + 1]]) as f32 / 32768.0;
            audio_data_f32.push(sample);
        }
    }

    log::info!("Converted {} samples to f32 format", audio_data_f32.len());

    // Log sample data statistics for debugging
    if !audio_data_f32.is_empty() {
        let min_sample = audio_data_f32.iter().fold(f32::MAX, |a, &b| a.min(b));
        let max_sample = audio_data_f32.iter().fold(f32::MIN, |a, &b| a.max(b));
        let avg_sample = audio_data_f32.iter().sum::<f32>() / audio_data_f32.len() as f32;
        log::info!("Audio samples - min: {min_sample}, max: {max_sample}, avg: {avg_sample}");

        // Sample a few values
        let sample_count = audio_data_f32.len().min(10);
        for i in 0..sample_count {
            let idx = i * audio_data_f32.len() / sample_count;
            log::info!("Sample {}: {}", idx, audio_data_f32[idx]);
        }
    }

    // Run the transcription
    let mut state = context
        .create_state()
        .map_err(|e| format!("Failed to create Whisper state: {e}"))?;

    state
        .full(params, &audio_data_f32[..])
        .map_err(|e| format!("Failed to run Whisper transcription: {e}"))?;

    // Process results: convert Whisper segments to CaptionSegment
    let num_segments = state
        .full_n_segments()
        .map_err(|e| format!("Failed to get number of segments: {e}"))?;

    log::info!("Found {num_segments} segments");

    let mut segments = Vec::new();

    for i in 0..num_segments {
        let text = state
            .full_get_segment_text(i)
            .map_err(|e| format!("Failed to get segment text: {e}"))?;

        // Properly unwrap the Result first, then convert i64 to f64
        let start_i64 = state
            .full_get_segment_t0(i)
            .map_err(|e| format!("Failed to get segment start time: {e}"))?;
        let end_i64 = state
            .full_get_segment_t1(i)
            .map_err(|e| format!("Failed to get segment end time: {e}"))?;

        // Convert timestamps from centiseconds to seconds (as f32 for CaptionSegment)
        let start_time = (start_i64 as f32) / 100.0;
        let end_time = (end_i64 as f32) / 100.0;

        // Add debug logging for timestamps
        log::info!(
            "Segment {}: start={}, end={}, text='{}'",
            i,
            start_time,
            end_time,
            text.trim()
        );

        if !text.trim().is_empty() {
            segments.push(CaptionSegment {
                id: format!("segment-{i}"),
                start: start_time,
                end: end_time,
                text: text.trim().to_string(),
            });
        }
    }

    log::info!("Successfully processed {} segments", segments.len());

    Ok(CaptionData {
        segments,
        settings: Some(cap_project::CaptionSettings::default()),
    })
}

/// Function to transcribe audio from a video file using Whisper
#[tauri::command]
#[specta::specta]
#[instrument]
pub async fn transcribe_audio(
    video_path: String,
    model_path: String,
    language: String,
) -> Result<CaptionData, String> {
    // Check if files exist with detailed error messages
    if !std::path::Path::new(&video_path).exists() {
        return Err(format!("Video file not found at path: {video_path}"));
    }

    if !std::path::Path::new(&model_path).exists() {
        return Err(format!("Model file not found at path: {model_path}"));
    }

    // Create temp dir with better error handling
    let temp_dir = tempdir().map_err(|e| format!("Failed to create temporary directory: {e}"))?;
    let audio_path = temp_dir.path().join("audio.wav");

    // First try the ffmpeg implementation
    match extract_audio_from_video(&video_path, &audio_path).await {
        Ok(_) => log::info!("Successfully extracted audio to {audio_path:?}"),
        Err(e) => {
            log::error!("Failed to extract audio: {e}");
            return Err(format!("Failed to extract audio from video: {e}"));
        }
    }

    // Verify the audio file was created
    if !audio_path.exists() {
        return Err("Failed to create audio file for transcription".to_string());
    }

    log::info!("Audio file created at: {audio_path:?}");

    // Get or initialize Whisper context with detailed error handling
    let context = match get_whisper_context(&model_path).await {
        Ok(ctx) => ctx,
        Err(e) => {
            log::error!("Failed to initialize Whisper context: {e}");
            return Err(format!("Failed to initialize transcription model: {e}"));
        }
    };

    // Process with Whisper and handle errors
    match process_with_whisper(&audio_path, context, &language) {
        Ok(captions) => {
            if captions.segments.is_empty() {
                log::warn!("No caption segments were generated");
                return Err("No speech detected in the audio".to_string());
            }
            Ok(captions)
        }
        Err(e) => {
            log::error!("Failed to process audio with Whisper: {e}");
            Err(format!("Failed to transcribe audio: {e}"))
        }
    }
}

/// Function to save caption data to a file
#[tauri::command]
#[specta::specta]
#[instrument(skip(app))]
pub async fn save_captions(
    app: AppHandle,
    video_id: String,
    captions: CaptionData,
) -> Result<(), String> {
    tracing::info!("Saving captions for video_id: {}", video_id);

    let captions_dir = app_captions_dir(&app, &video_id)?;

    if !captions_dir.exists() {
        tracing::info!("Creating captions directory: {:?}", captions_dir);
        std::fs::create_dir_all(&captions_dir).map_err(|e| {
            tracing::error!("Failed to create captions directory: {}", e);
            format!("Failed to create captions directory: {e}")
        })?;
    }

    let captions_path = captions_dir.join("captions.json");

    tracing::info!("Writing captions to: {:?}", captions_path);

    // Ensure settings are included with default values if not provided
    let settings = captions.settings.unwrap_or_default();

    // Create a JSON structure manually to ensure field naming consistency
    let mut json_obj = serde_json::Map::new();

    // Add segments array
    let segments_array = serde_json::to_value(
        captions
            .segments
            .iter()
            .map(|seg| {
                let mut segment = serde_json::Map::new();
                segment.insert("id".to_string(), serde_json::Value::String(seg.id.clone()));
                segment.insert(
                    "start".to_string(),
                    serde_json::Value::Number(
                        serde_json::Number::from_f64(seg.start as f64).unwrap(),
                    ),
                );
                segment.insert(
                    "end".to_string(),
                    serde_json::Value::Number(
                        serde_json::Number::from_f64(seg.end as f64).unwrap(),
                    ),
                );
                segment.insert(
                    "text".to_string(),
                    serde_json::Value::String(seg.text.clone()),
                );
                segment
            })
            .collect::<Vec<_>>(),
    )
    .map_err(|e| {
        tracing::error!("Failed to serialize captions segments: {}", e);
        format!("Failed to serialize captions: {e}")
    })?;

    json_obj.insert("segments".to_string(), segments_array);

    // Add settings object with camelCase naming
    let mut settings_obj = serde_json::Map::new();
    settings_obj.insert(
        "enabled".to_string(),
        serde_json::Value::Bool(settings.enabled),
    );
    settings_obj.insert(
        "font".to_string(),
        serde_json::Value::String(settings.font.clone()),
    );
    settings_obj.insert(
        "size".to_string(),
        serde_json::Value::Number(serde_json::Number::from(settings.size)),
    );
    settings_obj.insert(
        "color".to_string(),
        serde_json::Value::String(settings.color.clone()),
    );
    settings_obj.insert(
        "backgroundColor".to_string(),
        serde_json::Value::String(settings.background_color.clone()),
    );
    settings_obj.insert(
        "backgroundOpacity".to_string(),
        serde_json::Value::Number(serde_json::Number::from(settings.background_opacity)),
    );
    settings_obj.insert(
        "position".to_string(),
        serde_json::Value::String(settings.position.clone()),
    );
    settings_obj.insert("bold".to_string(), serde_json::Value::Bool(settings.bold));
    settings_obj.insert(
        "italic".to_string(),
        serde_json::Value::Bool(settings.italic),
    );
    settings_obj.insert(
        "outline".to_string(),
        serde_json::Value::Bool(settings.outline),
    );
    settings_obj.insert(
        "outlineColor".to_string(),
        serde_json::Value::String(settings.outline_color.clone()),
    );
    settings_obj.insert(
        "exportWithSubtitles".to_string(),
        serde_json::Value::Bool(settings.export_with_subtitles),
    );

    json_obj.insert(
        "settings".to_string(),
        serde_json::Value::Object(settings_obj),
    );

    // Convert to pretty JSON string
    let json = serde_json::to_string_pretty(&json_obj).map_err(|e| {
        tracing::error!("Failed to serialize captions: {}", e);
        format!("Failed to serialize captions: {e}")
    })?;

    std::fs::write(captions_path, json).map_err(|e| {
        tracing::error!("Failed to write captions file: {}", e);
        format!("Failed to write captions file: {e}")
    })?;

    tracing::info!("Successfully saved captions");
    Ok(())
}

/// Helper function to parse captions from a JSON string
/// This can be used by other modules to parse captions without duplicating code
pub fn parse_captions_json(json: &str) -> Result<cap_project::CaptionsData, String> {
    // Use a more flexible parsing approach
    match serde_json::from_str::<serde_json::Value>(json) {
        Ok(json_value) => {
            if let Some(segments_array) = json_value.get("segments").and_then(|v| v.as_array()) {
                let mut segments = Vec::new();

                // Process each segment
                for segment in segments_array {
                    if let (Some(id), Some(start), Some(end), Some(text)) = (
                        segment.get("id").and_then(|v| v.as_str()),
                        segment.get("start").and_then(|v| v.as_f64()),
                        segment.get("end").and_then(|v| v.as_f64()),
                        segment.get("text").and_then(|v| v.as_str()),
                    ) {
                        segments.push(cap_project::CaptionSegment {
                            id: id.to_string(),
                            start: start as f32,
                            end: end as f32,
                            text: text.to_string(),
                        });
                    }
                }

                // Get settings or use defaults
                let settings = if let Some(settings_obj) = json_value.get("settings") {
                    // Extract each field with proper fallbacks
                    let enabled = settings_obj
                        .get("enabled")
                        .and_then(|v| v.as_bool())
                        .unwrap_or_default();
                    let font = settings_obj
                        .get("font")
                        .and_then(|v| v.as_str())
                        .unwrap_or("System Sans-Serif")
                        .to_string();
                    let size = settings_obj
                        .get("size")
                        .and_then(|v| v.as_u64())
                        .unwrap_or(24) as u32;
                    let color = settings_obj
                        .get("color")
                        .and_then(|v| v.as_str())
                        .unwrap_or("#FFFFFF")
                        .to_string();

                    // Handle both camelCase and snake_case field names
                    let background_color = settings_obj
                        .get("backgroundColor")
                        .or_else(|| settings_obj.get("background_color"))
                        .and_then(|v| v.as_str())
                        .unwrap_or("#000000")
                        .to_string();

                    let background_opacity = settings_obj
                        .get("backgroundOpacity")
                        .or_else(|| settings_obj.get("background_opacity"))
                        .and_then(|v| v.as_u64())
                        .unwrap_or(80) as u32;

                    let position = settings_obj
                        .get("position")
                        .and_then(|v| v.as_str())
                        .unwrap_or("bottom")
                        .to_string();
                    let bold = settings_obj
                        .get("bold")
                        .and_then(|v| v.as_bool())
                        .unwrap_or(true);
                    let italic = settings_obj
                        .get("italic")
                        .and_then(|v| v.as_bool())
                        .unwrap_or(false);
                    let outline = settings_obj
                        .get("outline")
                        .and_then(|v| v.as_bool())
                        .unwrap_or(true);

                    let outline_color = settings_obj
                        .get("outlineColor")
                        .or_else(|| settings_obj.get("outline_color"))
                        .and_then(|v| v.as_str())
                        .unwrap_or("#000000")
                        .to_string();

                    let export_with_subtitles = settings_obj
                        .get("exportWithSubtitles")
                        .or_else(|| settings_obj.get("export_with_subtitles"))
                        .and_then(|v| v.as_bool())
                        .unwrap_or(false);

                    cap_project::CaptionSettings {
                        enabled,
                        font,
                        size,
                        color,
                        background_color,
                        background_opacity,
                        position,
                        bold,
                        italic,
                        outline,
                        outline_color,
                        export_with_subtitles,
                    }
                } else {
                    // Use default settings if none provided
                    cap_project::CaptionSettings::default()
                };

                Ok(cap_project::CaptionsData { segments, settings })
            } else {
                Err("Missing or invalid segments array in captions file".to_string())
            }
        }
        Err(e) => Err(format!("Failed to parse captions JSON: {e}")),
    }
}

/// Function to load caption data from a file
#[tauri::command]
#[specta::specta]
#[instrument(skip(app))]
pub async fn load_captions(
    app: AppHandle,
    video_id: String,
) -> Result<Option<CaptionData>, String> {
    let captions_dir = app_captions_dir(&app, &video_id)?;
    let captions_path = captions_dir.join("captions.json");

    if !captions_path.exists() {
        tracing::info!("No captions file found at: {:?}", captions_path);
        return Ok(None);
    }

    tracing::info!("Reading captions from: {:?}", captions_path);
    let json = match std::fs::read_to_string(captions_path.clone()) {
        Ok(j) => j,
        Err(e) => {
            tracing::error!("Failed to read captions file: {}", e);
            return Err(format!("Failed to read captions file: {e}"));
        }
    };

    tracing::info!("Parsing captions JSON");
    match parse_captions_json(&json) {
        Ok(project_captions) => {
            tracing::info!(
                "Successfully loaded {} caption segments",
                project_captions.segments.len()
            );

            // Create the CaptionData structure
            let tauri_captions = CaptionData {
                segments: project_captions.segments,
                settings: Some(project_captions.settings),
            };

            Ok(Some(tauri_captions))
        }
        Err(e) => {
            tracing::error!("Failed to parse captions: {}", e);
            Err(format!("Failed to parse captions: {e}"))
        }
    }
}

/// Helper function to get the captions directory for a video
fn app_captions_dir(app: &AppHandle, video_id: &str) -> Result<PathBuf, String> {
    tracing::info!("Getting captions directory for video_id: {}", video_id);

    // Get the app data directory
    let app_dir = app
        .path()
        .app_data_dir()
        .map_err(|_| "Failed to get app data directory".to_string())?;

    // Create a dedicated captions directory
    // Strip .cap extension if present in video_id
    let clean_video_id = video_id.trim_end_matches(".cap");
    let captions_dir = app_dir.join("captions").join(clean_video_id);

    tracing::info!("Captions directory path: {:?}", captions_dir);
    Ok(captions_dir)
}

// Add new type for download progress
#[derive(Debug, Serialize, Type, tauri_specta::Event, Clone)]
pub struct DownloadProgress {
    pub progress: f64,
    pub message: String,
}

impl DownloadProgress {
    const EVENT_NAME: &'static str = "download-progress";
}

/// Helper function to download a Whisper model from Hugging Face Hub
#[tauri::command]
#[specta::specta]
#[instrument(skip(window))]
pub async fn download_whisper_model(
    app: AppHandle,
    window: Window,
    model_name: String,
    output_path: String,
) -> Result<(), String> {
    // Define model URLs based on model names
    let model_url = match model_name.as_str() {
        "tiny" => "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.bin",
        "base" => "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin",
        "small" => "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin",
        "medium" => "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-medium.bin",
        "large" => "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3.bin",
        "large-v3" => "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3.bin",
        _ => "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.bin", // Default to tiny
    };

    // Create the client and download the model
    let response = app
        .state::<http_client::HttpClient>()
        .get(model_url)
        .send()
        .await
        .map_err(|e| format!("Failed to download model: {e}"))?;

    if !response.status().is_success() {
        return Err(format!(
            "Failed to download model: HTTP {}",
            response.status()
        ));
    }

    // Get the total size for progress calculation
    let total_size = response.content_length().unwrap_or(0);

    // Create a file to write to
    if let Some(parent) = std::path::Path::new(&output_path).parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create parent directories: {e}"))?;
    }
    let mut file = tokio::fs::File::create(&output_path)
        .await
        .map_err(|e| format!("Failed to create file: {e}"))?;

    // Download and write in chunks
    let mut downloaded = 0;
    let mut bytes = response
        .bytes()
        .await
        .map_err(|e| format!("Failed to get response bytes: {e}"))?;

    // Write the bytes in chunks to show progress
    const CHUNK_SIZE: usize = 1024 * 1024; // 1MB chunks
    while !bytes.is_empty() {
        let chunk_size = std::cmp::min(CHUNK_SIZE, bytes.len());
        let chunk = bytes.split_to(chunk_size);

        file.write_all(&chunk)
            .await
            .map_err(|e| format!("Error while writing to file: {e}"))?;

        downloaded += chunk_size as u64;

        // Calculate and emit progress
        let progress = if total_size > 0 {
            (downloaded as f64 / total_size as f64) * 100.0
        } else {
            0.0
        };

        window
            .emit(
                DownloadProgress::EVENT_NAME,
                DownloadProgress {
                    message: format!("Downloading model: {progress:.1}%"),
                    progress,
                },
            )
            .map_err(|e| format!("Failed to emit progress: {e}"))?;
    }

    // Ensure file is properly written
    file.flush()
        .await
        .map_err(|e| format!("Failed to flush file: {e}"))?;

    Ok(())
}

/// Function to check if a model file exists
#[tauri::command]
#[specta::specta]
#[instrument]
pub async fn check_model_exists(model_path: String) -> Result<bool, String> {
    Ok(std::path::Path::new(&model_path).exists())
}

/// Function to delete a downloaded model
#[tauri::command]
#[specta::specta]
#[instrument]
pub async fn delete_whisper_model(model_path: String) -> Result<(), String> {
    if !std::path::Path::new(&model_path).exists() {
        return Err(format!("Model file not found: {model_path}"));
    }

    tokio::fs::remove_file(&model_path)
        .await
        .map_err(|e| format!("Failed to delete model file: {e}"))?;

    Ok(())
}

/// Convert caption segments to SRT format
fn captions_to_srt(captions: &CaptionData) -> String {
    let mut srt = String::new();
    for (i, segment) in captions.segments.iter().enumerate() {
        // Convert start and end times from seconds to HH:MM:SS,mmm format
        let start_time = format_srt_time(f64::from(segment.start));
        let end_time = format_srt_time(f64::from(segment.end));

        // Write SRT entry
        srt.push_str(&format!(
            "{}\n{} --> {}\n{}\n\n",
            i + 1,
            start_time,
            end_time,
            segment.text.trim()
        ));
    }
    srt
}

/// Format time in seconds to SRT time format (HH:MM:SS,mmm)
fn format_srt_time(seconds: f64) -> String {
    let hours = (seconds / 3600.0) as i32;
    let minutes = ((seconds % 3600.0) / 60.0) as i32;
    let secs = (seconds % 60.0) as i32;
    let millis = ((seconds % 1.0) * 1000.0) as i32;
    format!("{hours:02}:{minutes:02}:{secs:02},{millis:03}")
}

/// Export captions to an SRT file
#[tauri::command]
#[specta::specta]
#[instrument(skip(app))]
pub async fn export_captions_srt(
    app: AppHandle,
    video_id: String,
) -> Result<Option<PathBuf>, String> {
    tracing::info!("Starting SRT export for video_id: {}", video_id);

    // Load captions
    let captions = match load_captions(app.clone(), video_id.clone()).await? {
        Some(c) => {
            tracing::info!("Found {} caption segments to export", c.segments.len());
            c
        }
        None => {
            tracing::info!("No captions found for video_id: {}", video_id);
            return Ok(None);
        }
    };

    // Ensure we have settings (this should already be handled by load_captions,
    // but we add this check for extra safety)
    let captions_with_settings = CaptionData {
        segments: captions.segments,
        settings: captions
            .settings
            .or_else(|| Some(CaptionSettings::default())),
    };

    // Convert to SRT format
    tracing::info!("Converting captions to SRT format");
    let srt_content = captions_to_srt(&captions_with_settings);

    // Get path for SRT file
    let captions_dir = app_captions_dir(&app, &video_id)?;
    let srt_path = captions_dir.join("captions.srt");
    tracing::info!("Will write SRT file to: {:?}", srt_path);

    // Write SRT file
    match std::fs::write(&srt_path, srt_content) {
        Ok(_) => {
            tracing::info!("Successfully wrote SRT file to: {:?}", srt_path);
            Ok(Some(srt_path))
        }
        Err(e) => {
            tracing::error!("Failed to write SRT file: {}", e);
            Err(format!("Failed to write SRT file: {e}"))
        }
    }
}

// Helper function to convert multi-channel audio to mono
fn convert_to_mono(samples: &[f32], channels: usize) -> Vec<f32> {
    if channels == 1 {
        return samples.to_vec();
    }

    let sample_count = samples.len() / channels;
    let mut mono_samples = Vec::with_capacity(sample_count);

    for i in 0..sample_count {
        let mut sample_sum = 0.0;
        for c in 0..channels {
            sample_sum += samples[i * channels + c];
        }
        mono_samples.push(sample_sum / channels as f32);
    }

    mono_samples
}

// Helper function to mix two sample arrays together
fn mix_samples(dest: &mut [f32], source: &[f32]) -> usize {
    let length = dest.len().min(source.len());
    for i in 0..length {
        // Simple mix with equal weight (0.5) to prevent clipping
        dest[i] = (dest[i] + source[i]) * 0.5;
    }
    length
}
