use anyhow::Result;
use cap_audio::AudioData;
use ffmpeg::{
    ChannelLayout, codec as avcodec,
    format::{self as avformat},
    software::resampling,
};
use futures::StreamExt;
#[cfg(not(all(target_os = "macos", target_arch = "x86_64")))]
use parakeet_rs::{ParakeetTDT, TimestampMode, Transcriber};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::fs::File;
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;
use tauri::{AppHandle, Manager};
use tauri_specta::Event;
use tempfile::tempdir;
use tokio::io::AsyncWriteExt;
use tokio::sync::Mutex;
use tracing::instrument;
use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters};

pub use cap_project::{CaptionSegment, CaptionSettings, CaptionWord};

use crate::{general_settings::GeneralSettingsStore, http_client};

#[cfg(all(target_os = "macos", target_arch = "x86_64"))]
const PARAKEET_UNSUPPORTED_MESSAGE: &str = "Parakeet transcription is not available on Intel macOS";

#[derive(Debug, Serialize, Deserialize, Type, Clone)]
pub enum TranscriptionEngine {
    Whisper,
    Parakeet,
}

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

lazy_static::lazy_static! {
    static ref WHISPER_CONTEXT: Arc<Mutex<Option<Arc<WhisperContext>>>> = Arc::new(Mutex::new(None));
}

#[cfg(not(all(target_os = "macos", target_arch = "x86_64")))]
lazy_static::lazy_static! {
    static ref PARAKEET_CONTEXT: Mutex<Option<CachedParakeetContext>> = Mutex::new(None);
}

const WHISPER_SAMPLE_RATE: u32 = 16000;

#[cfg(not(all(target_os = "macos", target_arch = "x86_64")))]
struct CachedParakeetContext {
    model_dir: String,
    model: Arc<std::sync::Mutex<ParakeetTDT>>,
}

#[cfg(not(all(target_os = "macos", target_arch = "x86_64")))]
fn parakeet_model_dir_matches(cached_model_dir: &str, model_dir: &Path) -> bool {
    cached_model_dir == model_dir.to_string_lossy()
}

#[cfg(not(all(target_os = "macos", target_arch = "x86_64")))]
async fn invalidate_parakeet_cache_for_dir(model_dir: &Path) {
    let mut ctx = PARAKEET_CONTEXT.lock().await;
    if ctx
        .as_ref()
        .is_some_and(|cached| parakeet_model_dir_matches(&cached.model_dir, model_dir))
    {
        tracing::info!(
            "Invalidating cached Parakeet context for {}",
            model_dir.display()
        );
        *ctx = None;
    }
}

#[cfg(all(target_os = "macos", target_arch = "x86_64"))]
async fn invalidate_parakeet_cache_for_dir(_model_dir: &Path) {}

pub async fn release_ml_models() {
    {
        let mut ctx = WHISPER_CONTEXT.lock().await;
        if ctx.is_some() {
            tracing::info!("Releasing Whisper context to free memory");
            *ctx = None;
        }
    }
    #[cfg(not(all(target_os = "macos", target_arch = "x86_64")))]
    {
        let mut ctx = PARAKEET_CONTEXT.lock().await;
        if ctx.is_some() {
            tracing::info!("Releasing Parakeet context to free memory");
            *ctx = None;
        }
    }
}

fn normalize_relative_components(path: &Path) -> Result<PathBuf, String> {
    let mut normalized = PathBuf::new();

    for component in path.components() {
        match component {
            Component::Normal(part) => normalized.push(part),
            Component::CurDir => {}
            Component::ParentDir => {
                return Err("Path is outside the app data directory".to_string());
            }
            Component::RootDir => {
                return Err("Path is outside the app data directory".to_string());
            }
            Component::Prefix(_) => {
                return Err("Path is outside the app data directory".to_string());
            }
        }
    }

    Ok(normalized)
}

fn resolve_path_with_base(base_dir: &Path, path: &str) -> Result<PathBuf, String> {
    if !base_dir.exists() {
        std::fs::create_dir_all(base_dir)
            .map_err(|e| format!("Failed to create app data directory: {e}"))?;
    }

    let canonical_base = base_dir
        .canonicalize()
        .map_err(|e| format!("Failed to resolve app data directory: {e}"))?;
    let requested = PathBuf::from(path);
    let candidate = if requested.is_absolute() {
        requested
    } else {
        canonical_base.join(normalize_relative_components(&requested)?)
    };

    let mut suffix = Vec::new();
    let mut current = candidate.as_path();

    while !current.exists() {
        let file_name = current
            .file_name()
            .ok_or_else(|| "Path is outside the app data directory".to_string())?;
        suffix.push(file_name.to_os_string());
        current = current
            .parent()
            .ok_or_else(|| "Path is outside the app data directory".to_string())?;
    }

    let mut resolved = current
        .canonicalize()
        .map_err(|e| format!("Failed to resolve path: {e}"))?;

    if !resolved.starts_with(&canonical_base) {
        return Err("Path is outside the app data directory".to_string());
    }

    for component in suffix.into_iter().rev() {
        resolved.push(component);
    }

    Ok(resolved)
}

fn validate_model_path(app: &AppHandle, path: &str) -> Result<PathBuf, String> {
    let app_data_dir = app
        .path()
        .app_local_data_dir()
        .map_err(|_| "Failed to get app local data directory".to_string())?;

    resolve_path_with_base(&app_data_dir, path)
}

#[tauri::command]
#[specta::specta]
#[instrument]
pub async fn create_dir(path: String, _recursive: bool) -> Result<(), String> {
    std::fs::create_dir_all(path).map_err(|e| format!("Failed to create directory: {e}"))
}

#[tauri::command]
#[specta::specta]
#[instrument]
pub async fn save_model_file(path: String, data: Vec<u8>) -> Result<(), String> {
    std::fs::write(&path, &data).map_err(|e| format!("Failed to write model file: {e}"))
}

async fn extract_audio_from_video(video_path: &str, output_path: &PathBuf) -> Result<(), String> {
    log::info!("=== EXTRACT AUDIO START ===");
    log::info!("Attempting to extract audio from: {video_path}");
    log::info!("Output path: {output_path:?}");

    if video_path.ends_with(".cap") {
        log::info!("Detected .cap project directory");

        let meta_path = std::path::Path::new(video_path).join("recording-meta.json");
        let meta_content = std::fs::read_to_string(&meta_path)
            .map_err(|e| format!("Failed to read recording metadata: {e}"))?;

        let meta: serde_json::Value = serde_json::from_str(&meta_content)
            .map_err(|e| format!("Failed to parse recording metadata: {e}"))?;

        let base_path = std::path::Path::new(video_path);

        struct SegmentAudio {
            sources: Vec<PathBuf>,
        }

        let mut segment_audios: Vec<SegmentAudio> = Vec::new();

        if let Some(segments) = meta["segments"].as_array() {
            for segment in segments {
                let mut sources = Vec::new();
                let mut push_source = |path: Option<&str>| {
                    if let Some(path) = path {
                        let full_path = base_path.join(path);
                        if full_path.exists() && !sources.contains(&full_path) {
                            sources.push(full_path);
                        }
                    }
                };

                push_source(segment["system_audio"]["path"].as_str());
                push_source(segment["mic"]["path"].as_str());
                push_source(segment["audio"]["path"].as_str());

                if !sources.is_empty() {
                    segment_audios.push(SegmentAudio { sources });
                }
            }
        }

        if segment_audios.is_empty() {
            return Err("No audio sources found in the recording metadata".to_string());
        }

        log::info!("Found {} segments with audio sources", segment_audios.len());

        let mut final_samples: Vec<f32> = Vec::new();

        for (segment_idx, segment_audio) in segment_audios.iter().enumerate() {
            log::info!(
                "Processing segment {} with {} audio sources",
                segment_idx,
                segment_audio.sources.len()
            );

            let mut segment_samples: Vec<f32> = Vec::new();

            for source in &segment_audio.sources {
                match AudioData::from_file(source) {
                    Ok(audio) => {
                        log::info!(
                            "Processing audio source {:?}: {} channels, {} samples",
                            source,
                            audio.channels(),
                            audio.sample_count()
                        );

                        let mono_samples = if audio.channels() > 1 {
                            convert_to_mono(audio.samples(), audio.channels() as usize)
                        } else {
                            audio.samples().to_vec()
                        };

                        if segment_samples.is_empty() {
                            segment_samples = mono_samples;
                        } else {
                            mix_samples(&mut segment_samples, &mono_samples);
                        }
                    }
                    Err(e) => {
                        log::warn!("Failed to process audio source {source:?}: {e}");
                        continue;
                    }
                }
            }

            if !segment_samples.is_empty() {
                log::info!(
                    "Segment {} produced {} samples, appending to final audio",
                    segment_idx,
                    segment_samples.len()
                );
                final_samples.extend(segment_samples);
            }
        }

        let mixed_samples = final_samples;
        let channel_count = 1_usize;

        if mixed_samples.is_empty() {
            log::error!("No audio samples after processing all sources");
            return Err("Failed to process any audio sources".to_string());
        }

        log::info!("Final mixed audio: {} samples", mixed_samples.len());
        let mix_rms =
            (mixed_samples.iter().map(|&s| s * s).sum::<f32>() / mixed_samples.len() as f32).sqrt();
        log::info!("Mixed audio RMS: {mix_rms:.4}");

        if mix_rms < 0.001 {
            log::warn!(
                "WARNING: Mixed audio RMS is very low ({mix_rms:.6}) - audio may be nearly silent!"
            );
        }

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

        let mut resampler = resampling::Context::get(
            avformat::Sample::F32(avformat::sample::Type::Packed),
            channel_layout,
            AudioData::SAMPLE_RATE,
            avformat::Sample::I16(avformat::sample::Type::Packed),
            channel_layout,
            WHISPER_SAMPLE_RATE,
        )
        .map_err(|e| format!("Failed to create resampler: {e}"))?;

        let frame_size = encoder.frame_size() as usize;
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

        if !mixed_samples.is_empty() && frame_size * channel_count > 0 {
            for (chunk_idx, chunk) in mixed_samples.chunks(frame_size * channel_count).enumerate() {
                if chunk_idx % 100 == 0 {
                    log::info!("Processing chunk {}, size: {}", chunk_idx, chunk.len());
                }

                let mut input_frame = ffmpeg::frame::Audio::new(
                    avformat::Sample::F32(avformat::sample::Type::Packed),
                    chunk.len() / channel_count,
                    channel_layout,
                );
                input_frame.set_rate(AudioData::SAMPLE_RATE);

                let bytes = unsafe {
                    std::slice::from_raw_parts(
                        chunk.as_ptr() as *const u8,
                        std::mem::size_of_val(chunk),
                    )
                };
                input_frame.data_mut(0)[0..bytes.len()].copy_from_slice(bytes);

                let mut output_frame = ffmpeg::frame::Audio::new(
                    avformat::Sample::I16(avformat::sample::Type::Packed),
                    frame_size,
                    ChannelLayout::MONO,
                );
                output_frame.set_rate(WHISPER_SAMPLE_RATE);

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

        encoder
            .send_eof()
            .map_err(|e| format!("Failed to send EOF: {e}"))?;

        loop {
            let mut packet = ffmpeg::Packet::empty();
            let received = encoder.receive_packet(&mut packet);

            if received.is_err() {
                break;
            }

            {
                if let Err(e) = packet.write_interleaved(&mut output) {
                    return Err(format!("Failed to write final packet: {e}"));
                }
            }
        }

        output
            .write_trailer()
            .map_err(|e| format!("Failed to write trailer: {e}"))?;

        log::info!("=== EXTRACT AUDIO END (from .cap) ===");
        Ok(())
    } else {
        let mut input =
            avformat::input(&video_path).map_err(|e| format!("Failed to open video file: {e}"))?;

        let stream = input
            .streams()
            .best(ffmpeg::media::Type::Audio)
            .ok_or_else(|| "No audio stream found".to_string())?;

        let codec_params = stream.parameters();

        let decoder_ctx = avcodec::Context::from_parameters(codec_params.clone())
            .map_err(|e| format!("Failed to create decoder context: {e}"))?;

        let mut decoder = decoder_ctx
            .decoder()
            .audio()
            .map_err(|e| format!("Failed to create decoder: {e}"))?;

        let decoder_format = decoder.format();
        let decoder_channel_layout = decoder.channel_layout();
        let decoder_rate = decoder.rate();

        let channel_layout = ChannelLayout::MONO;

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

        let mut output = avformat::output(&output_path)
            .map_err(|e| format!("Failed to create output file: {e}"))?;

        let stream_params = {
            let mut output_stream = output
                .add_stream(codec)
                .map_err(|e| format!("Failed to add stream: {e}"))?;

            output_stream.set_parameters(&encoder);

            (output_stream.index(), output_stream.id())
        };

        output
            .write_header()
            .map_err(|e| format!("Failed to write header: {e}"))?;

        let mut resampler = resampling::Context::get(
            decoder_format,
            decoder_channel_layout,
            decoder_rate,
            avformat::Sample::I16(avformat::sample::Type::Packed),
            channel_layout,
            WHISPER_SAMPLE_RATE,
        )
        .map_err(|e| format!("Failed to create resampler: {e}"))?;

        let mut decoded_frame = ffmpeg::frame::Audio::empty();
        let mut resampled_frame = ffmpeg::frame::Audio::new(
            avformat::Sample::I16(avformat::sample::Type::Packed),
            encoder.frame_size() as usize,
            channel_layout,
        );

        let input_stream_index = stream.index();

        let mut packet_queue = Vec::new();

        {
            for (stream_idx, packet) in input.packets() {
                if stream_idx.index() == input_stream_index
                    && let Some(data) = packet.data()
                {
                    let mut cloned_packet = ffmpeg::Packet::copy(data);
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

        for packet_res in packet_queue {
            if let Err(e) = decoder.send_packet(&packet_res) {
                log::warn!("Failed to send packet to decoder: {e}");
                continue;
            }

            while decoder.receive_frame(&mut decoded_frame).is_ok() {
                if let Err(e) = resampler.run(&decoded_frame, &mut resampled_frame) {
                    log::warn!("Failed to resample audio: {e}");
                    continue;
                }

                if let Err(e) = encoder.send_frame(&resampled_frame) {
                    log::warn!("Failed to send frame to encoder: {e}");
                    continue;
                }

                loop {
                    let mut packet = ffmpeg::Packet::empty();
                    match encoder.receive_packet(&mut packet) {
                        Ok(_) => {
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

        output
            .write_trailer()
            .map_err(|e| format!("Failed to write trailer: {e}"))?;

        log::info!("=== EXTRACT AUDIO END (from video) ===");
        Ok(())
    }
}

async fn get_whisper_context(model_path: &str) -> Result<Arc<WhisperContext>, String> {
    let mut context_guard = WHISPER_CONTEXT.lock().await;

    if let Some(ref existing) = *context_guard {
        log::info!("Reusing cached Whisper context");
        return Ok(existing.clone());
    }

    log::info!("Initializing Whisper context with model: {model_path}");
    let ctx = WhisperContext::new_with_params(model_path, WhisperContextParameters::default())
        .map_err(|e| format!("Failed to load Whisper model: {e}"))?;

    let ctx_arc = Arc::new(ctx);
    *context_guard = Some(ctx_arc.clone());

    Ok(ctx_arc)
}

fn is_special_token(token_text: &str) -> bool {
    let trimmed = token_text.trim();
    if trimmed.is_empty() {
        return true;
    }

    let is_special = trimmed.contains('[')
        || trimmed.contains(']')
        || trimmed.contains("_TT_")
        || trimmed.contains("_BEG_")
        || trimmed.contains("<|");

    if is_special {
        log::debug!("Filtering special token: {token_text:?}");
    }

    is_special
}

fn process_with_whisper(
    audio_path: &PathBuf,
    context: Arc<WhisperContext>,
    language: &str,
    transcription_hints: &[String],
) -> Result<CaptionData, String> {
    log::info!("=== WHISPER TRANSCRIPTION START ===");
    log::info!("Processing audio file: {audio_path:?}");
    log::info!("Language setting: {language}");

    let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });

    params.set_translate(false);
    params.set_print_special(false);
    params.set_print_progress(false);
    params.set_print_realtime(false);
    params.set_token_timestamps(true);
    params.set_language(Some(if language == "auto" { "auto" } else { language }));
    params.set_max_len(i32::MAX);

    if let Some(initial_prompt) = build_initial_prompt(transcription_hints) {
        params.set_initial_prompt(&initial_prompt);
    }

    log::info!("Whisper params - translate: false, token_timestamps: true, max_len: MAX");

    let mut audio_file = File::open(audio_path)
        .map_err(|e| format!("Failed to open audio file: {e} at path: {audio_path:?}"))?;
    let mut audio_data = Vec::new();
    audio_file
        .read_to_end(&mut audio_data)
        .map_err(|e| format!("Failed to read audio file: {e}"))?;

    log::info!("Processing audio file of size: {} bytes", audio_data.len());

    let mut audio_data_f32 = Vec::new();
    for i in (0..audio_data.len()).step_by(2) {
        if i + 1 < audio_data.len() {
            let sample = i16::from_le_bytes([audio_data[i], audio_data[i + 1]]) as f32 / 32768.0;
            audio_data_f32.push(sample);
        }
    }

    let duration_seconds = audio_data_f32.len() as f32 / WHISPER_SAMPLE_RATE as f32;
    log::info!(
        "Converted {} samples to f32 format (duration: {:.2}s at {}Hz)",
        audio_data_f32.len(),
        duration_seconds,
        WHISPER_SAMPLE_RATE
    );

    if !audio_data_f32.is_empty() {
        let min_sample = audio_data_f32.iter().fold(f32::MAX, |a, &b| a.min(b));
        let max_sample = audio_data_f32.iter().fold(f32::MIN, |a, &b| a.max(b));
        let avg_sample = audio_data_f32.iter().sum::<f32>() / audio_data_f32.len() as f32;
        let rms = (audio_data_f32.iter().map(|&s| s * s).sum::<f32>()
            / audio_data_f32.len() as f32)
            .sqrt();
        log::info!(
            "Audio samples - min: {min_sample:.4}, max: {max_sample:.4}, avg: {avg_sample:.6}, RMS: {rms:.4}"
        );

        if rms < 0.001 {
            log::warn!("WARNING: Audio RMS is very low ({rms:.6}) - audio may be nearly silent!");
        }

        log::info!("First 20 audio samples:");
        for (i, sample) in audio_data_f32.iter().take(20).enumerate() {
            log::info!("  Sample[{i}] = {sample:.6}");
        }
    }

    let mut state = context
        .create_state()
        .map_err(|e| format!("Failed to create Whisper state: {e}"))?;

    state
        .full(params, &audio_data_f32[..])
        .map_err(|e| format!("Failed to run Whisper transcription: {e}"))?;

    let num_segments = state
        .full_n_segments()
        .map_err(|e| format!("Failed to get number of segments: {e}"))?;

    log::info!("Found {num_segments} segments");

    let mut segments = Vec::new();

    for i in 0..num_segments {
        let raw_text = state
            .full_get_segment_text(i)
            .map_err(|e| format!("Failed to get segment text: {e}"))?;

        let start_i64 = state
            .full_get_segment_t0(i)
            .map_err(|e| format!("Failed to get segment start time: {e}"))?;
        let end_i64 = state
            .full_get_segment_t1(i)
            .map_err(|e| format!("Failed to get segment end time: {e}"))?;

        let start_time = (start_i64 as f32) / 100.0;
        let end_time = (end_i64 as f32) / 100.0;

        log::info!(
            "=== Segment {}: start={:.2}s, end={:.2}s, raw_text='{}'",
            i,
            start_time,
            end_time,
            raw_text.trim()
        );

        let mut words = Vec::new();
        let num_tokens = state
            .full_n_tokens(i)
            .map_err(|e| format!("Failed to get token count: {e}"))?;

        log::info!("  Segment {i} has {num_tokens} tokens");

        let mut current_word = String::new();
        let mut word_start: Option<f32> = None;
        let mut word_end: f32 = start_time;

        for t in 0..num_tokens {
            let token_text = state.full_get_token_text(i, t).unwrap_or_default();
            let token_id = state.full_get_token_id(i, t).unwrap_or(0);
            let token_prob = state.full_get_token_prob(i, t).unwrap_or(0.0);

            if is_special_token(&token_text) {
                log::debug!(
                    "  Token[{t}]: id={token_id}, text={token_text:?} -> SKIPPED (special)"
                );
                continue;
            }

            let token_data = state.full_get_token_data(i, t).ok();

            if let Some(data) = token_data {
                let token_start = (data.t0 as f32) / 100.0;
                let token_end = (data.t1 as f32) / 100.0;

                log::info!(
                    "  Token[{t}]: id={token_id}, text={token_text:?}, t0={token_start:.2}s, t1={token_end:.2}s, prob={token_prob:.4}"
                );

                if token_text.starts_with(' ') || token_text.starts_with('\n') {
                    if !current_word.is_empty()
                        && let Some(ws) = word_start
                    {
                        log::info!(
                            "    -> Completing word: '{}' ({:.2}s - {:.2}s)",
                            current_word.trim(),
                            ws,
                            word_end
                        );
                        words.push(CaptionWord {
                            text: current_word.trim().to_string(),
                            start: ws,
                            end: word_end,
                        });
                    }
                    current_word = token_text.trim().to_string();
                    word_start = Some(token_start);
                    log::debug!("    -> Starting new word: '{current_word}' at {token_start:.2}s");
                } else {
                    if word_start.is_none() {
                        word_start = Some(token_start);
                        log::debug!("    -> Word start set to {token_start:.2}s");
                    }
                    current_word.push_str(&token_text);
                    log::debug!("    -> Appending to word: '{current_word}'");
                }
                word_end = token_end;
            } else {
                log::warn!("  Token[{t}]: id={token_id}, text={token_text:?} -> NO TIMING DATA");
            }
        }

        if !current_word.trim().is_empty()
            && let Some(ws) = word_start
        {
            log::info!(
                "    -> Final word: '{}' ({:.2}s - {:.2}s)",
                current_word.trim(),
                ws,
                word_end
            );
            words.push(CaptionWord {
                text: current_word.trim().to_string(),
                start: ws,
                end: word_end,
            });
        }

        log::info!("  Segment {} produced {} words", i, words.len());
        for (w_idx, word) in words.iter().enumerate() {
            log::info!(
                "    Word[{}]: '{}' ({:.2}s - {:.2}s)",
                w_idx,
                word.text,
                word.start,
                word.end
            );
        }

        if words.is_empty() {
            log::warn!("  Segment {i} has no words, skipping");
            continue;
        }

        const MAX_WORDS_PER_SEGMENT: usize = 6;

        let word_chunks: Vec<Vec<CaptionWord>> = words
            .chunks(MAX_WORDS_PER_SEGMENT)
            .map(|chunk| chunk.to_vec())
            .collect();

        for (chunk_idx, chunk_words) in word_chunks.into_iter().enumerate() {
            let segment_text = chunk_words
                .iter()
                .map(|word| word.text.clone())
                .collect::<Vec<_>>()
                .join(" ");

            let segment_start = chunk_words
                .first()
                .map(|word| word.start)
                .unwrap_or(start_time);
            let segment_end = chunk_words.last().map(|word| word.end).unwrap_or(end_time);

            segments.push(CaptionSegment {
                id: format!("segment-{i}-{chunk_idx}"),
                start: segment_start,
                end: segment_end,
                text: segment_text,
                words: chunk_words,
            });
        }
    }

    log::info!("=== WHISPER TRANSCRIPTION COMPLETE ===");
    log::info!("Total segments: {}", segments.len());

    let total_words: usize = segments.iter().map(|s| s.words.len()).sum();
    log::info!("Total words: {total_words}");

    log::info!("=== FINAL TRANSCRIPTION SUMMARY ===");
    for segment in &segments {
        log::info!(
            "Segment '{}' ({:.2}s - {:.2}s): {}",
            segment.id,
            segment.start,
            segment.end,
            segment.text
        );
    }
    log::info!("=== END SUMMARY ===");

    Ok(CaptionData {
        segments,
        settings: Some(cap_project::CaptionSettings::default()),
    })
}

fn build_initial_prompt(transcription_hints: &[String]) -> Option<String> {
    let mut normalized = Vec::new();

    for hint in transcription_hints {
        let value = hint.replace('\0', "").trim().to_string();
        if value.is_empty() || normalized.contains(&value) {
            continue;
        }
        normalized.push(value);
    }

    if normalized.is_empty() {
        None
    } else {
        Some(format!(
            "Preferred spellings, names, and capitalization for this transcript: {}",
            normalized.join("; ")
        ))
    }
}

#[cfg(not(all(target_os = "macos", target_arch = "x86_64")))]
fn process_with_parakeet(
    audio_path: &std::path::Path,
    model_dir: &str,
) -> Result<CaptionData, String> {
    tracing::info!("Processing audio file: {audio_path:?}");
    tracing::info!("Model directory: {model_dir}");

    let model_arc = {
        let mut guard = PARAKEET_CONTEXT.blocking_lock();

        let should_reload = guard
            .as_ref()
            .is_none_or(|cached| cached.model_dir != model_dir);

        if should_reload {
            tracing::info!("Loading Parakeet TDT model from: {model_dir}");
            let model =
                ParakeetTDT::from_pretrained(model_dir, None).map_err(|e| format!("{e}"))?;
            let model_arc = Arc::new(std::sync::Mutex::new(model));
            *guard = Some(CachedParakeetContext {
                model_dir: model_dir.to_string(),
                model: Arc::clone(&model_arc),
            });
            tracing::info!("Parakeet TDT model loaded successfully");
            model_arc
        } else {
            tracing::info!("Reusing cached Parakeet TDT model");
            Arc::clone(&guard.as_ref().unwrap().model)
        }
    };

    let result = {
        let mut parakeet = model_arc
            .lock()
            .map_err(|e| format!("Failed to lock Parakeet model: {e}"))?;
        parakeet
            .transcribe_file(audio_path, Some(TimestampMode::Words))
            .map_err(|e| format!("Parakeet transcription failed: {e}"))?
    };

    tracing::info!("Transcription text: {}", result.text);
    tracing::info!("Got {} timed tokens", result.tokens.len());

    let words: Vec<CaptionWord> = result
        .tokens
        .iter()
        .filter(|t| !t.text.trim().is_empty())
        .map(|t| CaptionWord {
            text: t.text.trim().to_string(),
            start: t.start,
            end: t.end,
        })
        .collect();

    if words.is_empty() {
        tracing::warn!("Parakeet produced no words");
        return Err("No speech detected in the audio".to_string());
    }

    const MAX_WORDS_PER_SEGMENT: usize = 6;

    let mut segments = Vec::new();
    let word_chunks: Vec<&[CaptionWord]> = words.chunks(MAX_WORDS_PER_SEGMENT).collect();

    for (chunk_idx, chunk) in word_chunks.iter().enumerate() {
        let segment_text = chunk
            .iter()
            .map(|w| w.text.clone())
            .collect::<Vec<_>>()
            .join(" ");

        let segment_start = chunk.first().map(|w| w.start).unwrap_or(0.0);
        let segment_end = chunk.last().map(|w| w.end).unwrap_or(0.0);

        segments.push(CaptionSegment {
            id: format!("segment-{chunk_idx}"),
            start: segment_start,
            end: segment_end,
            text: segment_text,
            words: chunk.to_vec(),
        });
    }

    tracing::info!("Total segments: {}", segments.len());
    tracing::info!(
        "Total words: {}",
        segments.iter().map(|s| s.words.len()).sum::<usize>()
    );

    Ok(CaptionData {
        segments,
        settings: Some(cap_project::CaptionSettings::default()),
    })
}

#[cfg(all(target_os = "macos", target_arch = "x86_64"))]
fn process_with_parakeet(
    _audio_path: &std::path::Path,
    _model_dir: &str,
) -> Result<CaptionData, String> {
    Err(PARAKEET_UNSUPPORTED_MESSAGE.to_string())
}

#[tauri::command]
#[specta::specta]
#[instrument]
pub async fn transcribe_audio(
    app: AppHandle,
    video_path: String,
    model_path: String,
    language: String,
    engine: TranscriptionEngine,
) -> Result<CaptionData, String> {
    log::info!("=== TRANSCRIBE AUDIO COMMAND START ===");
    log::info!("Video path: {}", video_path);
    log::info!("Model path: {}", model_path);
    log::info!("Language: {}", language);

    let validated_model_path = validate_model_path(&app, &model_path)?;

    if !std::path::Path::new(&video_path).exists() {
        log::error!("Video file not found at path: {video_path}");
        return Err(format!("Video file not found at path: {video_path}"));
    }

    if !validated_model_path.exists() {
        log::error!("Model file not found at path: {model_path}");
        return Err(format!("Model file not found at path: {model_path}"));
    }

    let model_path = validated_model_path.to_string_lossy().to_string();

    let temp_dir = tempdir().map_err(|e| format!("Failed to create temporary directory: {e}"))?;
    let audio_path = temp_dir.path().join("audio.wav");
    log::info!("Temp audio path: {:?}", audio_path);

    match extract_audio_from_video(&video_path, &audio_path).await {
        Ok(_) => log::info!("Successfully extracted audio to {audio_path:?}"),
        Err(e) => {
            log::error!("Failed to extract audio: {e}");
            return Err(format!("Failed to extract audio from video: {e}"));
        }
    }

    if !audio_path.exists() {
        log::error!("Audio file was not created at {audio_path:?}");
        return Err("Failed to create audio file for transcription".to_string());
    }

    let audio_metadata = std::fs::metadata(&audio_path).ok();
    if let Some(meta) = &audio_metadata {
        log::info!(
            "Audio file created at: {:?}, size: {} bytes",
            audio_path,
            meta.len()
        );
    }

    let transcription_result = match engine {
        TranscriptionEngine::Parakeet => {
            log::info!("Using Parakeet TDT engine");
            let model_dir = model_path.clone();
            tokio::task::spawn_blocking(move || process_with_parakeet(&audio_path, &model_dir))
                .await
                .map_err(|e| format!("Parakeet task panicked: {e}"))?
        }
        TranscriptionEngine::Whisper => {
            let context = match get_whisper_context(&model_path).await {
                Ok(ctx) => {
                    log::info!("Whisper context ready");
                    ctx
                }
                Err(e) => {
                    log::error!("Failed to initialize Whisper context: {e}");
                    return Err(format!("Failed to initialize transcription model: {e}"));
                }
            };

            let transcription_hints = GeneralSettingsStore::get(&app)
                .ok()
                .flatten()
                .map(|settings| settings.transcription_hints)
                .unwrap_or_default();

            log::info!("Starting Whisper transcription in blocking task...");
            tokio::task::spawn_blocking(move || {
                process_with_whisper(&audio_path, context, &language, &transcription_hints)
            })
            .await
            .map_err(|e| format!("Whisper task panicked: {e}"))?
        }
    };

    match transcription_result {
        Ok(captions) => {
            log::info!("=== TRANSCRIBE AUDIO RESULT ===");
            log::info!(
                "Transcription produced {} segments",
                captions.segments.len()
            );

            for (idx, segment) in captions.segments.iter().enumerate() {
                log::info!(
                    "  Result Segment[{}]: '{}' ({} words)",
                    idx,
                    segment.text,
                    segment.words.len()
                );
            }

            if captions.segments.is_empty() {
                log::warn!("No caption segments were generated");
                return Err("No speech detected in the audio".to_string());
            }

            log::info!("=== TRANSCRIBE AUDIO COMMAND END (success) ===");
            Ok(captions)
        }
        Err(e) => {
            log::error!("Failed to process audio with Whisper: {e}");
            log::info!("=== TRANSCRIBE AUDIO COMMAND END (error) ===");
            Err(format!("Failed to transcribe audio: {e}"))
        }
    }
}

#[tauri::command]
#[specta::specta]
#[instrument(skip(app))]
pub async fn save_captions(
    app: AppHandle,
    video_id: String,
    captions: CaptionData,
) -> Result<(), String> {
    tracing::info!("=== SAVE CAPTIONS START ===");
    tracing::info!("Saving captions for video_id: {}", video_id);
    tracing::info!("Received {} segments to save", captions.segments.len());

    for (idx, segment) in captions.segments.iter().enumerate() {
        tracing::info!(
            "  Segment[{}] '{}': '{}' ({} words, {:.2}s - {:.2}s)",
            idx,
            segment.id,
            segment.text,
            segment.words.len(),
            segment.start,
            segment.end
        );
        for (w_idx, word) in segment.words.iter().enumerate() {
            tracing::debug!(
                "    Word[{}]: '{}' ({:.2}s - {:.2}s)",
                w_idx,
                word.text,
                word.start,
                word.end
            );
        }
    }

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

    let settings = captions.settings.unwrap_or_default();

    let mut json_obj = serde_json::Map::new();

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
                let words_array: Vec<serde_json::Value> = seg
                    .words
                    .iter()
                    .map(|w| {
                        serde_json::json!({
                            "text": w.text,
                            "start": w.start,
                            "end": w.end
                        })
                    })
                    .collect();
                segment.insert("words".to_string(), serde_json::Value::Array(words_array));
                segment
            })
            .collect::<Vec<_>>(),
    )
    .map_err(|e| {
        tracing::error!("Failed to serialize captions segments: {}", e);
        format!("Failed to serialize captions: {e}")
    })?;

    json_obj.insert("segments".to_string(), segments_array);

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
    settings_obj.insert(
        "italic".to_string(),
        serde_json::Value::Bool(settings.italic),
    );
    settings_obj.insert(
        "fontWeight".to_string(),
        serde_json::Value::Number(serde_json::Number::from(settings.font_weight)),
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
    settings_obj.insert(
        "highlightColor".to_string(),
        serde_json::Value::String(settings.highlight_color.clone()),
    );
    settings_obj.insert(
        "fadeDuration".to_string(),
        serde_json::Value::Number(
            serde_json::Number::from_f64(settings.fade_duration as f64).unwrap(),
        ),
    );
    settings_obj.insert(
        "lingerDuration".to_string(),
        serde_json::Value::Number(
            serde_json::Number::from_f64(settings.linger_duration as f64).unwrap(),
        ),
    );
    settings_obj.insert(
        "wordTransitionDuration".to_string(),
        serde_json::Value::Number(
            serde_json::Number::from_f64(settings.word_transition_duration as f64).unwrap(),
        ),
    );
    settings_obj.insert(
        "activeWordHighlight".to_string(),
        serde_json::Value::Bool(settings.active_word_highlight),
    );

    json_obj.insert(
        "settings".to_string(),
        serde_json::Value::Object(settings_obj),
    );

    let json = serde_json::to_string_pretty(&json_obj).map_err(|e| {
        tracing::error!("Failed to serialize captions: {}", e);
        format!("Failed to serialize captions: {e}")
    })?;

    std::fs::write(captions_path, json).map_err(|e| {
        tracing::error!("Failed to write captions file: {}", e);
        format!("Failed to write captions file: {e}")
    })?;

    tracing::info!("Successfully saved captions");
    tracing::info!("=== SAVE CAPTIONS END ===");
    Ok(())
}

pub fn parse_captions_json(json: &str) -> Result<cap_project::CaptionsData, String> {
    match serde_json::from_str::<serde_json::Value>(json) {
        Ok(json_value) => {
            if let Some(segments_array) = json_value.get("segments").and_then(|v| v.as_array()) {
                let mut segments = Vec::new();

                for segment in segments_array {
                    if let (Some(id), Some(start), Some(end), Some(text)) = (
                        segment.get("id").and_then(|v| v.as_str()),
                        segment.get("start").and_then(|v| v.as_f64()),
                        segment.get("end").and_then(|v| v.as_f64()),
                        segment.get("text").and_then(|v| v.as_str()),
                    ) {
                        let mut words = Vec::new();
                        if let Some(words_array) = segment.get("words").and_then(|v| v.as_array()) {
                            for word in words_array {
                                if let (Some(w_text), Some(w_start), Some(w_end)) = (
                                    word.get("text").and_then(|v| v.as_str()),
                                    word.get("start").and_then(|v| v.as_f64()),
                                    word.get("end").and_then(|v| v.as_f64()),
                                ) {
                                    words.push(cap_project::CaptionWord {
                                        text: w_text.to_string(),
                                        start: w_start as f32,
                                        end: w_end as f32,
                                    });
                                }
                            }
                        }
                        segments.push(cap_project::CaptionSegment {
                            id: id.to_string(),
                            start: start as f32,
                            end: end as f32,
                            text: text.to_string(),
                            words,
                        });
                    }
                }

                let settings = if let Some(settings_obj) = json_value.get("settings") {
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
                        .unwrap_or("#A0A0A0")
                        .to_string();

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
                    let italic = settings_obj
                        .get("italic")
                        .and_then(|v| v.as_bool())
                        .unwrap_or(false);
                    let font_weight = settings_obj
                        .get("fontWeight")
                        .or_else(|| settings_obj.get("font_weight"))
                        .and_then(|v| v.as_u64())
                        .unwrap_or(700) as u32;
                    let outline = settings_obj
                        .get("outline")
                        .and_then(|v| v.as_bool())
                        .unwrap_or(false);

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

                    let highlight_color = settings_obj
                        .get("highlightColor")
                        .or_else(|| settings_obj.get("highlight_color"))
                        .and_then(|v| v.as_str())
                        .unwrap_or("#FFFFFF")
                        .to_string();

                    let fade_duration = settings_obj
                        .get("fadeDuration")
                        .or_else(|| settings_obj.get("fade_duration"))
                        .and_then(|v| v.as_f64())
                        .unwrap_or(0.15) as f32;

                    let linger_duration = settings_obj
                        .get("lingerDuration")
                        .or_else(|| settings_obj.get("linger_duration"))
                        .and_then(|v| v.as_f64())
                        .unwrap_or(0.4) as f32;

                    let word_transition_duration = settings_obj
                        .get("wordTransitionDuration")
                        .or_else(|| settings_obj.get("word_transition_duration"))
                        .and_then(|v| v.as_f64())
                        .unwrap_or(0.25) as f32;

                    let active_word_highlight = settings_obj
                        .get("activeWordHighlight")
                        .or_else(|| settings_obj.get("active_word_highlight"))
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
                        italic,
                        font_weight,
                        outline,
                        outline_color,
                        export_with_subtitles,
                        highlight_color,
                        fade_duration,
                        linger_duration,
                        word_transition_duration,
                        active_word_highlight,
                    }
                } else {
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

#[tauri::command]
#[specta::specta]
#[instrument(skip(app))]
pub async fn load_captions(
    app: AppHandle,
    video_id: String,
) -> Result<Option<CaptionData>, String> {
    tracing::info!("=== LOAD CAPTIONS START ===");
    tracing::info!("Loading captions for video_id: {}", video_id);

    let captions_dir = app_captions_dir(&app, &video_id)?;
    let captions_path = captions_dir.join("captions.json");

    if !captions_path.exists() {
        tracing::info!("No captions file found at: {:?}", captions_path);
        tracing::info!("=== LOAD CAPTIONS END (no file) ===");
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

    tracing::info!("Captions JSON length: {} bytes", json.len());

    tracing::info!("Parsing captions JSON");
    match parse_captions_json(&json) {
        Ok(project_captions) => {
            tracing::info!(
                "Successfully loaded {} caption segments",
                project_captions.segments.len()
            );

            for (idx, segment) in project_captions.segments.iter().enumerate() {
                tracing::info!(
                    "  Loaded Segment[{}] '{}': '{}' ({} words, {:.2}s - {:.2}s)",
                    idx,
                    segment.id,
                    segment.text,
                    segment.words.len(),
                    segment.start,
                    segment.end
                );
            }

            let tauri_captions = CaptionData {
                segments: project_captions.segments,
                settings: Some(project_captions.settings),
            };

            tracing::info!("=== LOAD CAPTIONS END (success) ===");
            Ok(Some(tauri_captions))
        }
        Err(e) => {
            tracing::error!("Failed to parse captions: {}", e);
            tracing::info!("=== LOAD CAPTIONS END (error) ===");
            Err(format!("Failed to parse captions: {e}"))
        }
    }
}

fn app_captions_dir(app: &AppHandle, video_id: &str) -> Result<PathBuf, String> {
    tracing::info!("Getting captions directory for video_id: {}", video_id);

    let app_dir = app
        .path()
        .app_data_dir()
        .map_err(|_| "Failed to get app data directory".to_string())?;

    let clean_video_id = video_id.trim_end_matches(".cap");
    let captions_dir = app_dir.join("captions").join(clean_video_id);

    tracing::info!("Captions directory path: {:?}", captions_dir);
    Ok(captions_dir)
}

#[derive(Debug, Serialize, Type, tauri_specta::Event, Clone)]
pub struct DownloadProgress {
    pub progress: f64,
    pub message: String,
}

#[tauri::command]
#[specta::specta]
#[instrument(skip(app))]
pub async fn download_whisper_model(
    app: AppHandle,
    model_name: String,
    output_path: String,
) -> Result<(), String> {
    let validated_path = validate_model_path(&app, &output_path)?;

    let model_url = match model_name.as_str() {
        "tiny" => "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.bin",
        "base" => "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin",
        "small" => "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin",
        "medium" => "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-medium.bin",
        "large" => "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3.bin",
        "large-v3" => "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3.bin",
        _ => "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.bin",
    };

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

    let total_size = response.content_length().unwrap_or(0);

    if let Some(parent) = validated_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create parent directories: {e}"))?;
    }
    let mut file = tokio::fs::File::create(&validated_path)
        .await
        .map_err(|e| format!("Failed to create file: {e}"))?;

    let mut downloaded: u64 = 0;
    let mut stream = response.bytes_stream();

    while let Some(chunk_result) = stream.next().await {
        let chunk = chunk_result.map_err(|e| format!("Error while downloading: {e}"))?;

        file.write_all(&chunk)
            .await
            .map_err(|e| format!("Error while writing to file: {e}"))?;

        downloaded += chunk.len() as u64;

        let progress = if total_size > 0 {
            (downloaded as f64 / total_size as f64) * 100.0
        } else {
            0.0
        };

        DownloadProgress {
            progress,
            message: format!("Downloading model: {progress:.1}%"),
        }
        .emit(&app)
        .ok();
    }

    file.flush()
        .await
        .map_err(|e| format!("Failed to flush file: {e}"))?;

    Ok(())
}

#[tauri::command]
#[specta::specta]
#[instrument(skip(app))]
pub async fn check_model_exists(app: AppHandle, model_path: String) -> Result<bool, String> {
    let validated_path = validate_model_path(&app, &model_path)?;
    Ok(validated_path.exists())
}

#[tauri::command]
#[specta::specta]
#[instrument(skip(app))]
pub async fn delete_whisper_model(app: AppHandle, model_path: String) -> Result<(), String> {
    let validated_path = validate_model_path(&app, &model_path)?;

    if !validated_path.exists() {
        return Err(format!("Model file not found: {model_path}"));
    }

    tokio::fs::remove_file(&validated_path)
        .await
        .map_err(|e| format!("Failed to delete model file: {e}"))?;

    Ok(())
}

const PARAKEET_TDT_INT8_MODEL_FILES: &[(&str, &str)] = &[
    (
        "encoder-model.int8.onnx",
        "https://huggingface.co/altunenes/parakeet-rs/resolve/main/tdt/encoder-model.int8.onnx",
    ),
    (
        "decoder_joint-model.int8.onnx",
        "https://huggingface.co/altunenes/parakeet-rs/resolve/main/tdt/decoder_joint-model.int8.onnx",
    ),
    (
        "vocab.txt",
        "https://huggingface.co/altunenes/parakeet-rs/resolve/main/tdt/vocab.txt",
    ),
];

const PARAKEET_TDT_FULL_MODEL_FILES: &[(&str, &str)] = &[
    (
        "encoder-model.onnx",
        "https://huggingface.co/altunenes/parakeet-rs/resolve/main/tdt/encoder-model.onnx",
    ),
    (
        "encoder-model.onnx.data",
        "https://huggingface.co/altunenes/parakeet-rs/resolve/main/tdt/encoder-model.onnx.data",
    ),
    (
        "decoder_joint-model.onnx",
        "https://huggingface.co/altunenes/parakeet-rs/resolve/main/tdt/decoder_joint-model.onnx",
    ),
    (
        "vocab.txt",
        "https://huggingface.co/altunenes/parakeet-rs/resolve/main/tdt/vocab.txt",
    ),
];

const PARAKEET_MODEL_CLEANUP_FILES: &[&str] = &[
    "encoder-model.onnx",
    "encoder-model.onnx.data",
    "decoder_joint-model.onnx",
    "encoder-model.int8.onnx",
    "decoder_joint-model.int8.onnx",
    "nemo128.onnx",
    "vocab.txt",
];

fn parakeet_model_files_for_dir(
    output_dir: &std::path::Path,
) -> &'static [(&'static str, &'static str)] {
    let dir_name = output_dir.file_name().and_then(|name| name.to_str());

    match dir_name {
        Some("parakeet-best-max") => PARAKEET_TDT_FULL_MODEL_FILES,
        _ => PARAKEET_TDT_INT8_MODEL_FILES,
    }
}

#[cfg(not(all(target_os = "macos", target_arch = "x86_64")))]
#[tauri::command]
#[specta::specta]
#[instrument(skip(app))]
pub async fn download_parakeet_model(app: AppHandle, output_dir: String) -> Result<(), String> {
    let validated_dir = validate_model_path(&app, &output_dir)?;

    std::fs::create_dir_all(&validated_dir)
        .map_err(|e| format!("Failed to create model directory: {e}"))?;

    let staging_dir = validated_dir.with_file_name(format!(
        "{}.downloading",
        validated_dir
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("model")
    ));
    if staging_dir.exists() {
        std::fs::remove_dir_all(&staging_dir)
            .map_err(|e| format!("Failed to clean staging directory: {e}"))?;
    }
    std::fs::create_dir_all(&staging_dir)
        .map_err(|e| format!("Failed to create staging directory: {e}"))?;

    let http_client = app.state::<http_client::HttpClient>();
    let model_files = parakeet_model_files_for_dir(&validated_dir);

    let mut total_size: u64 = 0;
    let mut file_sizes: Vec<u64> = Vec::new();

    for (filename, url) in model_files {
        let resp = http_client
            .head(*url)
            .send()
            .await
            .map_err(|e| format!("Failed to get size for {filename}: {e}"))?;
        let size = resp.content_length().unwrap_or(0);
        file_sizes.push(size);
        total_size += size;
    }

    let mut downloaded_total: u64 = 0;

    let download_result: Result<(), String> = async {
        for (idx, (filename, url)) in model_files.iter().enumerate() {
            tracing::info!("Downloading {filename} from {url}");

            let response = http_client
                .get(*url)
                .send()
                .await
                .map_err(|e| format!("Failed to download {filename}: {e}"))?;

            if !response.status().is_success() {
                return Err(format!(
                    "Failed to download {filename}: HTTP {}",
                    response.status()
                ));
            }

            let file_path = staging_dir.join(filename);
            let mut file = tokio::fs::File::create(&file_path)
                .await
                .map_err(|e| format!("Failed to create {filename}: {e}"))?;

            let mut stream = response.bytes_stream();
            while let Some(chunk_result) = stream.next().await {
                let chunk =
                    chunk_result.map_err(|e| format!("Download error for {filename}: {e}"))?;
                file.write_all(&chunk)
                    .await
                    .map_err(|e| format!("Write error for {filename}: {e}"))?;

                downloaded_total += chunk.len() as u64;

                let progress = if total_size > 0 {
                    (downloaded_total as f64 / total_size as f64) * 100.0
                } else {
                    ((idx as f64 + 0.5) / model_files.len() as f64) * 100.0
                };

                DownloadProgress {
                    progress,
                    message: format!("Downloading {filename}: {progress:.1}%"),
                }
                .emit(&app)
                .ok();
            }

            file.flush()
                .await
                .map_err(|e| format!("Failed to flush {filename}: {e}"))?;

            tracing::info!("Finished downloading {filename}");
        }
        Ok(())
    }
    .await;

    if let Err(e) = &download_result {
        tracing::warn!("Download failed, cleaning up staging directory: {e}");
        let _ = std::fs::remove_dir_all(&staging_dir);
        return Err(e.clone());
    }

    invalidate_parakeet_cache_for_dir(&validated_dir).await;

    for filename in PARAKEET_MODEL_CLEANUP_FILES {
        let file_path = validated_dir.join(filename);
        if file_path.exists() {
            let _ = std::fs::remove_file(&file_path);
        }
    }

    for (filename, _) in model_files {
        let src = staging_dir.join(filename);
        let dst = validated_dir.join(filename);
        std::fs::rename(&src, &dst)
            .map_err(|e| format!("Failed to move {filename} to final location: {e}"))?;
    }

    let _ = std::fs::remove_dir_all(&staging_dir);

    Ok(())
}

#[cfg(all(target_os = "macos", target_arch = "x86_64"))]
#[tauri::command]
#[specta::specta]
#[instrument(skip(_app))]
pub async fn download_parakeet_model(_app: AppHandle, _output_dir: String) -> Result<(), String> {
    Err(PARAKEET_UNSUPPORTED_MESSAGE.to_string())
}

#[cfg(not(all(target_os = "macos", target_arch = "x86_64")))]
#[tauri::command]
#[specta::specta]
#[instrument(skip(app))]
pub async fn check_parakeet_model_exists(
    app: AppHandle,
    model_dir: String,
) -> Result<bool, String> {
    let validated_dir = validate_model_path(&app, &model_dir)?;

    if !validated_dir.is_dir() {
        return Ok(false);
    }

    let has_vocab = validated_dir.join("vocab.txt").exists();
    let has_full_model = validated_dir.join("encoder-model.onnx").exists()
        && validated_dir.join("encoder-model.onnx.data").exists()
        && validated_dir.join("decoder_joint-model.onnx").exists();
    let has_int8_model = validated_dir.join("encoder-model.int8.onnx").exists()
        && validated_dir.join("decoder_joint-model.int8.onnx").exists();

    Ok(has_vocab && (has_full_model || has_int8_model))
}

#[cfg(all(target_os = "macos", target_arch = "x86_64"))]
#[tauri::command]
#[specta::specta]
#[instrument(skip(_app))]
pub async fn check_parakeet_model_exists(
    _app: AppHandle,
    _model_dir: String,
) -> Result<bool, String> {
    Ok(false)
}

#[tauri::command]
#[specta::specta]
#[instrument(skip(app))]
pub async fn delete_parakeet_model(app: AppHandle, model_dir: String) -> Result<(), String> {
    let validated_dir = validate_model_path(&app, &model_dir)?;

    if !validated_dir.exists() {
        return Err(format!("Model directory not found: {model_dir}"));
    }

    invalidate_parakeet_cache_for_dir(&validated_dir).await;

    tokio::fs::remove_dir_all(&validated_dir)
        .await
        .map_err(|e| format!("Failed to delete model directory: {e}"))?;

    Ok(())
}

fn captions_to_srt(captions: &CaptionData) -> String {
    let mut srt = String::new();
    for (i, segment) in captions.segments.iter().enumerate() {
        let start_time = format_srt_time(f64::from(segment.start));
        let end_time = format_srt_time(f64::from(segment.end));

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

fn format_srt_time(seconds: f64) -> String {
    let hours = (seconds / 3600.0) as i32;
    let minutes = ((seconds % 3600.0) / 60.0) as i32;
    let secs = (seconds % 60.0) as i32;
    let millis = ((seconds % 1.0) * 1000.0) as i32;
    format!("{hours:02}:{minutes:02}:{secs:02},{millis:03}")
}

#[tauri::command]
#[specta::specta]
#[instrument(skip(app))]
pub async fn export_captions_srt(
    app: AppHandle,
    video_id: String,
) -> Result<Option<PathBuf>, String> {
    tracing::info!("Starting SRT export for video_id: {}", video_id);

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

    let captions_with_settings = CaptionData {
        segments: captions.segments,
        settings: captions
            .settings
            .or_else(|| Some(CaptionSettings::default())),
    };

    tracing::info!("Converting captions to SRT format");
    let srt_content = captions_to_srt(&captions_with_settings);

    let captions_dir = app_captions_dir(&app, &video_id)?;
    let srt_path = captions_dir.join("captions.srt");
    tracing::info!("Will write SRT file to: {:?}", srt_path);

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

fn mix_samples(dest: &mut [f32], source: &[f32]) -> usize {
    let length = dest.len().min(source.len());
    for i in 0..length {
        dest[i] = (dest[i] + source[i]) * 0.5;
    }
    length
}

#[cfg(test)]
mod tests {
    use super::resolve_path_with_base;
    use tempfile::tempdir;

    #[test]
    fn resolve_path_with_base_rejects_parent_dir_escape() {
        let dir = tempdir().unwrap();
        let base = dir.path().join("app-data");
        std::fs::create_dir_all(base.join("models")).unwrap();

        let escaped = base.join("..").join("outside.bin");

        let result = resolve_path_with_base(&base, escaped.to_string_lossy().as_ref());

        assert!(result.is_err());
    }

    #[test]
    fn resolve_path_with_base_allows_nested_model_path() {
        let dir = tempdir().unwrap();
        let base = dir.path().join("app-data");
        std::fs::create_dir_all(base.join("models")).unwrap();

        let target = base.join("models").join("nested").join("model.bin");
        let expected = base
            .canonicalize()
            .unwrap()
            .join("models")
            .join("nested")
            .join("model.bin");

        let resolved = resolve_path_with_base(&base, target.to_string_lossy().as_ref()).unwrap();

        assert_eq!(resolved, expected);
    }

    #[cfg(not(all(target_os = "macos", target_arch = "x86_64")))]
    mod parakeet {
        use super::super::parakeet_model_dir_matches;
        use tempfile::tempdir;

        #[test]
        fn parakeet_model_dir_match_uses_full_directory_path() {
            let dir = tempdir().unwrap();
            let model_dir = dir.path().join("models").join("parakeet-best");

            assert!(parakeet_model_dir_matches(
                model_dir.to_string_lossy().as_ref(),
                &model_dir
            ));
            assert!(!parakeet_model_dir_matches(
                dir.path()
                    .join("models")
                    .join("parakeet-best-max")
                    .to_string_lossy()
                    .as_ref(),
                &model_dir
            ));
        }
    }
}
