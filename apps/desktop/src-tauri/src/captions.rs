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
use std::process::Command;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager, Window};
use tempfile::tempdir;
use tokio::io::AsyncWriteExt;
use tokio::sync::Mutex;
use tracing::instrument;
use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters};

pub use cap_project::{CaptionSegment, CaptionSettings, CaptionWord};

use crate::http_client;

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

const WHISPER_SAMPLE_RATE: u32 = 16000;

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
    log::info!("Output path: {:?}", output_path);

    if video_path.ends_with(".cap") {
        log::info!("Detected .cap project directory");

        let meta_path = std::path::Path::new(video_path).join("recording-meta.json");
        let meta_content = std::fs::read_to_string(&meta_path)
            .map_err(|e| format!("Failed to read recording metadata: {e}"))?;

        let meta: serde_json::Value = serde_json::from_str(&meta_content)
            .map_err(|e| format!("Failed to parse recording metadata: {e}"))?;

        let base_path = std::path::Path::new(video_path);
        let mut audio_sources = Vec::new();

        if let Some(segments) = meta["segments"].as_array() {
            for segment in segments {
                let mut push_source = |path: Option<&str>| {
                    if let Some(path) = path {
                        let full_path = base_path.join(path);
                        if !audio_sources.contains(&full_path) {
                            audio_sources.push(full_path);
                        }
                    }
                };

                push_source(segment["system_audio"]["path"].as_str());
                push_source(segment["mic"]["path"].as_str());
                push_source(segment["audio"]["path"].as_str());
            }
        }

        if audio_sources.is_empty() {
            return Err("No audio sources found in the recording metadata".to_string());
        }

        log::info!("Found {} audio sources", audio_sources.len());

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
                        if audio.channels() as usize != channel_count {
                            log::info!(
                                "Channel count mismatch: {} vs {}, mixing to mono",
                                channel_count,
                                audio.channels()
                            );

                            if channel_count > 1 {
                                let mono_samples = convert_to_mono(&mixed_samples, channel_count);
                                mixed_samples = mono_samples;
                                channel_count = 1;
                            }

                            let samples = if audio.channels() > 1 {
                                convert_to_mono(audio.samples(), audio.channels() as usize)
                            } else {
                                audio.samples().to_vec()
                            };

                            mix_samples(&mut mixed_samples, &samples);
                        } else {
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

        if channel_count > 1 {
            log::info!("Converting final mixed audio from {channel_count} channels to mono");
            mixed_samples = convert_to_mono(&mixed_samples, channel_count);
            channel_count = 1;
        }

        if mixed_samples.is_empty() {
            log::error!("No audio samples after processing all sources");
            return Err("Failed to process any audio sources".to_string());
        }

        log::info!("Final mixed audio: {} samples", mixed_samples.len());
        let mix_rms =
            (mixed_samples.iter().map(|&s| s * s).sum::<f32>() / mixed_samples.len() as f32).sqrt();
        log::info!("Mixed audio RMS: {:.4}", mix_rms);

        if mix_rms < 0.001 {
            log::warn!(
                "WARNING: Mixed audio RMS is very low ({:.6}) - audio may be nearly silent!",
                mix_rms
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
                if stream_idx.index() == input_stream_index {
                    if let Some(data) = packet.data() {
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
        log::debug!("Filtering special token: {:?}", token_text);
    }

    is_special
}

fn process_with_whisper(
    audio_path: &PathBuf,
    context: Arc<WhisperContext>,
    language: &str,
) -> Result<CaptionData, String> {
    log::info!("=== WHISPER TRANSCRIPTION START ===");
    log::info!("Processing audio file: {audio_path:?}");
    log::info!("Language setting: {}", language);

    let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });

    params.set_translate(false);
    params.set_print_special(false);
    params.set_print_progress(false);
    params.set_print_realtime(false);
    params.set_token_timestamps(true);
    params.set_language(Some(if language == "auto" { "auto" } else { language }));
    params.set_max_len(i32::MAX);

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
            "Audio samples - min: {:.4}, max: {:.4}, avg: {:.6}, RMS: {:.4}",
            min_sample,
            max_sample,
            avg_sample,
            rms
        );

        if rms < 0.001 {
            log::warn!(
                "WARNING: Audio RMS is very low ({:.6}) - audio may be nearly silent!",
                rms
            );
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
                    "  Token[{}]: id={}, text={:?} -> SKIPPED (special)",
                    t,
                    token_id,
                    token_text
                );
                continue;
            }

            let token_data = state.full_get_token_data(i, t).ok();

            if let Some(data) = token_data {
                let token_start = (data.t0 as f32) / 100.0;
                let token_end = (data.t1 as f32) / 100.0;

                log::info!(
                    "  Token[{}]: id={}, text={:?}, t0={:.2}s, t1={:.2}s, prob={:.4}",
                    t,
                    token_id,
                    token_text,
                    token_start,
                    token_end,
                    token_prob
                );

                if token_text.starts_with(' ') || token_text.starts_with('\n') {
                    if !current_word.is_empty() {
                        if let Some(ws) = word_start {
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
                    }
                    current_word = token_text.trim().to_string();
                    word_start = Some(token_start);
                    log::debug!(
                        "    -> Starting new word: '{}' at {:.2}s",
                        current_word,
                        token_start
                    );
                } else {
                    if word_start.is_none() {
                        word_start = Some(token_start);
                        log::debug!("    -> Word start set to {:.2}s", token_start);
                    }
                    current_word.push_str(&token_text);
                    log::debug!("    -> Appending to word: '{}'", current_word);
                }
                word_end = token_end;
            } else {
                log::warn!(
                    "  Token[{}]: id={}, text={:?} -> NO TIMING DATA",
                    t,
                    token_id,
                    token_text
                );
            }
        }

        if !current_word.trim().is_empty() {
            if let Some(ws) = word_start {
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
            log::warn!("  Segment {} has no words, skipping", i);
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
    log::info!("Total words: {}", total_words);

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

fn find_python() -> Option<String> {
    let python_commands = if cfg!(target_os = "windows") {
        vec!["python", "python3", "py"]
    } else {
        vec!["python3", "python"]
    };

    for cmd in python_commands {
        if let Ok(output) = Command::new(cmd).arg("--version").output() {
            if output.status.success() {
                let version = String::from_utf8_lossy(&output.stdout);
                if version.contains("Python 3")
                    || String::from_utf8_lossy(&output.stderr).contains("Python 3")
                {
                    log::info!("Found Python 3 at: {}", cmd);
                    return Some(cmd.to_string());
                }
            }
        }
    }
    None
}

const WHISPERX_WHL_URL: &str =
    "https://github.com/m-bain/whisperX/releases/download/v3.7.4/whisperx-3.7.4-py3-none-any.whl";
const WHISPERX_WHL_NAME: &str = "whisperx-3.7.4-py3-none-any.whl";

lazy_static::lazy_static! {
    static ref WHISPERX_SERVER: Arc<Mutex<Option<WhisperXServer>>> = Arc::new(Mutex::new(None));
}

struct WhisperXServer {
    child: std::process::Child,
    stdin: std::io::BufWriter<std::process::ChildStdin>,
    stdout: std::io::BufReader<std::process::ChildStdout>,
    model_size: String,
}

impl Drop for WhisperXServer {
    fn drop(&mut self) {
        let _ = self.child.kill();
    }
}

fn get_whisperx_server_script() -> String {
    r#"
import os
import sys
import json

hf_cache = sys.argv[1]
torch_cache = sys.argv[2]
models_cache = sys.argv[3]

os.environ["HF_HOME"] = hf_cache
os.environ["HUGGINGFACE_HUB_CACHE"] = hf_cache
os.environ["TORCH_HOME"] = torch_cache
os.environ["XDG_CACHE_HOME"] = models_cache

import warnings
warnings.filterwarnings("ignore")

import torch
torch.hub.set_dir(torch_cache)

original_torch_load = torch.load
def patched_torch_load(*args, **kwargs):
    kwargs['weights_only'] = False
    return original_torch_load(*args, **kwargs)
torch.load = patched_torch_load

import whisperx

device = "cuda" if torch.cuda.is_available() else "cpu"
compute_type = "float16" if device == "cuda" else "int8"

cached_model = None
cached_model_size = None
cached_align_models = {}

def load_or_get_model(model_size, language, download_root):
    global cached_model, cached_model_size
    
    if cached_model is not None and cached_model_size == model_size:
        return cached_model
    
    print(f"STDERR:Loading WhisperX model: {model_size} on {device}", file=sys.stderr, flush=True)
    cached_model = whisperx.load_model(model_size, device, compute_type=compute_type, language=language, download_root=download_root)
    cached_model_size = model_size
    return cached_model

def load_or_get_align_model(language_code):
    global cached_align_models
    
    if language_code in cached_align_models:
        return cached_align_models[language_code]
    
    print(f"STDERR:Loading alignment model for: {language_code}", file=sys.stderr, flush=True)
    model_a, metadata = whisperx.load_align_model(language_code=language_code, device=device)
    cached_align_models[language_code] = (model_a, metadata)
    return model_a, metadata

print("READY", flush=True)

for line in sys.stdin:
    try:
        request = json.loads(line.strip())
        audio_file = request["audio_file"]
        model_size = request["model_size"]
        language = request.get("language")
        download_root = request["download_root"]
        
        if language == "" or language == "auto":
            language = None
        
        model = load_or_get_model(model_size, language, download_root)
        
        print(f"STDERR:Loading audio...", file=sys.stderr, flush=True)
        audio = whisperx.load_audio(audio_file)
        
        print(f"STDERR:Transcribing...", file=sys.stderr, flush=True)
        result = model.transcribe(audio, batch_size=16)
        
        detected_lang = result["language"]
        print(f"STDERR:Detected language: {detected_lang}", file=sys.stderr, flush=True)
        
        model_a, metadata = load_or_get_align_model(detected_lang)
        
        print(f"STDERR:Aligning words...", file=sys.stderr, flush=True)
        result = whisperx.align(result["segments"], model_a, metadata, audio, device, return_char_alignments=False)
        
        output = {"segments": []}
        for seg in result["segments"]:
            segment = {
                "start": seg["start"],
                "end": seg["end"],
                "text": seg["text"],
                "words": []
            }
            if "words" in seg:
                for w in seg["words"]:
                    word = {"word": w.get("word", "")}
                    if "start" in w:
                        word["start"] = w["start"]
                    if "end" in w:
                        word["end"] = w["end"]
                    segment["words"].append(word)
            output["segments"].append(segment)
        
        print(f"STDERR:WhisperX completed: {len(output['segments'])} segments", file=sys.stderr, flush=True)
        print(json.dumps({"success": True, "result": output}), flush=True)
        
    except Exception as e:
        print(json.dumps({"success": False, "error": str(e)}), flush=True)
"#.to_string()
}

fn ensure_server_script_exists() -> Result<PathBuf, String> {
    let cache_dir = get_whisperx_cache_dir()?;
    let script_path = cache_dir.join("whisperx_server.py");

    if !script_path.exists() {
        std::fs::write(&script_path, get_whisperx_server_script())
            .map_err(|e| format!("Failed to write server script: {}", e))?;
        log::info!("Created WhisperX server script at {:?}", script_path);
    }

    Ok(script_path)
}

fn start_whisperx_server(
    venv_python: &PathBuf,
    model_size: &str,
) -> Result<WhisperXServer, String> {
    let models_cache = get_whisperx_models_cache_dir()?;
    let hf_cache = get_huggingface_cache_dir()?;
    let torch_cache = get_torch_cache_dir()?;

    let script_path = ensure_server_script_exists()?;

    log::info!("Starting WhisperX server with model size: {}", model_size);

    let mut child = Command::new(venv_python)
        .arg(&script_path)
        .arg(hf_cache.to_string_lossy().to_string())
        .arg(torch_cache.to_string_lossy().to_string())
        .arg(models_cache.to_string_lossy().to_string())
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to start WhisperX server: {}", e))?;

    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| "Failed to get stdin".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Failed to get stdout".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "Failed to get stderr".to_string())?;

    let stdin = std::io::BufWriter::new(stdin);
    let mut stdout = std::io::BufReader::new(stdout);

    std::thread::spawn(move || {
        use std::io::BufRead;
        let reader = std::io::BufReader::new(stderr);
        for line in reader.lines() {
            if let Ok(line) = line {
                if line.starts_with("STDERR:") {
                    log::info!("[WhisperX] {}", &line[7..]);
                } else {
                    log::info!("[WhisperX stderr] {}", line);
                }
            }
        }
    });

    use std::io::BufRead;
    let mut ready_line = String::new();
    let start_time = std::time::Instant::now();
    let timeout = std::time::Duration::from_secs(120);

    loop {
        if start_time.elapsed() > timeout {
            let _ = child.kill();
            return Err("WhisperX server startup timed out".to_string());
        }

        ready_line.clear();
        match stdout.read_line(&mut ready_line) {
            Ok(0) => {
                let _ = child.kill();
                return Err("WhisperX server closed unexpectedly".to_string());
            }
            Ok(_) => {
                if ready_line.trim() == "READY" {
                    log::info!(
                        "WhisperX server is ready (took {:.1}s)",
                        start_time.elapsed().as_secs_f32()
                    );
                    break;
                }
            }
            Err(e) => {
                let _ = child.kill();
                return Err(format!("Error reading from WhisperX server: {}", e));
            }
        }
    }

    Ok(WhisperXServer {
        child,
        stdin,
        stdout,
        model_size: model_size.to_string(),
    })
}

fn is_server_communication_error(error: &str) -> bool {
    error.contains("Failed to send request to server")
        || error.contains("Failed to flush request")
        || error.contains("Failed to read response from server")
        || error.contains("Failed to parse server response")
        || error.contains("Server not available")
}

fn transcribe_with_server(
    server: &mut WhisperXServer,
    audio_path: &std::path::Path,
    model_size: &str,
    language: &str,
) -> Result<CaptionData, String> {
    use std::io::{BufRead, Write};

    let models_cache = get_whisperx_models_cache_dir()?;

    let request = serde_json::json!({
        "audio_file": audio_path.to_string_lossy(),
        "model_size": model_size,
        "language": if language == "auto" { "" } else { language },
        "download_root": models_cache.to_string_lossy(),
    });

    log::info!("Sending transcription request to WhisperX server");

    writeln!(server.stdin, "{request}")
        .map_err(|e| format!("Failed to send request to server: {e}"))?;
    server
        .stdin
        .flush()
        .map_err(|e| format!("Failed to flush request: {}", e))?;

    let mut response_line = String::new();
    server
        .stdout
        .read_line(&mut response_line)
        .map_err(|e| format!("Failed to read response from server: {}", e))?;

    let response: serde_json::Value = serde_json::from_str(&response_line)
        .map_err(|e| format!("Failed to parse server response: {}", e))?;

    if !response["success"].as_bool().unwrap_or(false) {
        let error = response["error"].as_str().unwrap_or("Unknown error");
        return Err(format!("WhisperX server error: {}", error));
    }

    let whisperx_result: WhisperXOutput = serde_json::from_value(response["result"].clone())
        .map_err(|e| format!("Failed to parse WhisperX output: {}", e))?;

    log::info!(
        "WhisperX server produced {} segments",
        whisperx_result.segments.len()
    );

    let mut segments = Vec::new();
    const MAX_WORDS_PER_SEGMENT: usize = 6;

    for (seg_idx, whisperx_seg) in whisperx_result.segments.iter().enumerate() {
        log::info!(
            "Segment {}: '{}' ({:.2}s - {:.2}s) with {} words",
            seg_idx,
            whisperx_seg.text.trim(),
            whisperx_seg.start,
            whisperx_seg.end,
            whisperx_seg.words.len()
        );

        let mut words: Vec<CaptionWord> = Vec::new();

        for (word_idx, w) in whisperx_seg.words.iter().enumerate() {
            let word_text = w.word.trim().to_string();
            if word_text.is_empty() {
                continue;
            }

            let word_start = w.start.unwrap_or_else(|| {
                if word_idx == 0 {
                    whisperx_seg.start
                } else if let Some(prev) = words.last() {
                    prev.end as f64
                } else {
                    whisperx_seg.start
                }
            });

            let word_end = w.end.unwrap_or_else(|| {
                if word_idx == whisperx_seg.words.len() - 1 {
                    whisperx_seg.end
                } else {
                    word_start + 0.2
                }
            });

            words.push(CaptionWord {
                text: word_text,
                start: word_start as f32,
                end: word_end as f32,
            });
        }

        if words.is_empty() {
            continue;
        }

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
                .map(|w| w.start)
                .unwrap_or(whisperx_seg.start as f32);
            let segment_end = chunk_words
                .last()
                .map(|w| w.end)
                .unwrap_or(whisperx_seg.end as f32);

            segments.push(CaptionSegment {
                id: format!("segment-{}-{}", seg_idx, chunk_idx),
                start: segment_start,
                end: segment_end,
                text: segment_text,
                words: chunk_words,
            });
        }
    }

    Ok(CaptionData {
        segments,
        settings: Some(cap_project::CaptionSettings::default()),
    })
}

fn get_whisperx_cache_dir() -> Result<PathBuf, String> {
    let cache_dir = dirs::cache_dir()
        .or_else(dirs::data_local_dir)
        .ok_or_else(|| "Could not determine cache directory".to_string())?;
    let whisperx_dir = cache_dir.join("cap").join("whisperx");
    std::fs::create_dir_all(&whisperx_dir)
        .map_err(|e| format!("Failed to create whisperx cache directory: {}", e))?;
    Ok(whisperx_dir)
}

fn get_whisperx_models_cache_dir() -> Result<PathBuf, String> {
    let cache_dir = get_whisperx_cache_dir()?;
    let models_dir = cache_dir.join("models");
    std::fs::create_dir_all(&models_dir)
        .map_err(|e| format!("Failed to create whisperx models cache directory: {}", e))?;
    Ok(models_dir)
}

fn get_huggingface_cache_dir() -> Result<PathBuf, String> {
    let cache_dir = get_whisperx_cache_dir()?;
    let hf_dir = cache_dir.join("huggingface");
    std::fs::create_dir_all(&hf_dir)
        .map_err(|e| format!("Failed to create huggingface cache directory: {}", e))?;
    Ok(hf_dir)
}

fn get_torch_cache_dir() -> Result<PathBuf, String> {
    let cache_dir = get_whisperx_cache_dir()?;
    let torch_dir = cache_dir.join("torch");
    std::fs::create_dir_all(&torch_dir)
        .map_err(|e| format!("Failed to create torch cache directory: {}", e))?;
    Ok(torch_dir)
}

fn get_venv_python() -> Result<PathBuf, String> {
    let cache_dir = get_whisperx_cache_dir()?;
    let venv_dir = cache_dir.join("venv");

    if cfg!(target_os = "windows") {
        Ok(venv_dir.join("Scripts").join("python.exe"))
    } else {
        Ok(venv_dir.join("bin").join("python"))
    }
}

fn create_venv_if_needed(system_python: &str) -> Result<PathBuf, String> {
    let cache_dir = get_whisperx_cache_dir()?;
    let venv_dir = cache_dir.join("venv");
    let venv_python = get_venv_python()?;

    if venv_python.exists() {
        log::info!("Virtual environment already exists at: {:?}", venv_dir);
        return Ok(venv_python);
    }

    log::info!(
        "Creating virtual environment at: {:?} using {}",
        venv_dir,
        system_python
    );

    let output = Command::new(system_python)
        .args(["-m", "venv", venv_dir.to_str().unwrap()])
        .output()
        .map_err(|e| format!("Failed to create venv: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("Failed to create virtual environment: {}", stderr));
    }

    if !venv_python.exists() {
        return Err("Virtual environment was created but python not found".to_string());
    }

    log::info!("Virtual environment created successfully");

    log::info!("Upgrading pip in virtual environment...");
    let pip_upgrade = Command::new(&venv_python)
        .args(["-m", "pip", "install", "--upgrade", "pip"])
        .output();

    if let Err(e) = pip_upgrade {
        log::warn!("Failed to upgrade pip in venv: {}", e);
    }

    Ok(venv_python)
}

fn download_whisperx_whl() -> Result<PathBuf, String> {
    let cache_dir = get_whisperx_cache_dir()?;
    let whl_path = cache_dir.join(WHISPERX_WHL_NAME);

    if whl_path.exists() {
        log::info!("WhisperX wheel already cached at: {:?}", whl_path);
        return Ok(whl_path);
    }

    log::info!("Downloading WhisperX wheel from: {}", WHISPERX_WHL_URL);

    let output = Command::new("curl")
        .args([
            "-L",
            "-o",
            whl_path.to_str().unwrap(),
            "--create-dirs",
            WHISPERX_WHL_URL,
        ])
        .output()
        .map_err(|e| format!("Failed to run curl: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("Failed to download WhisperX wheel: {}", stderr));
    }

    if !whl_path.exists() {
        return Err("WhisperX wheel was not downloaded".to_string());
    }

    log::info!("Successfully downloaded WhisperX wheel to: {:?}", whl_path);
    Ok(whl_path)
}

fn install_whisperx_in_venv(venv_python: &PathBuf) -> Result<(), String> {
    log::info!("Installing whisperx in virtual environment...");

    let whl_path = download_whisperx_whl()?;
    log::info!("Installing WhisperX from: {:?}", whl_path);

    let install_result = Command::new(venv_python)
        .args(["-m", "pip", "install", whl_path.to_str().unwrap()])
        .output()
        .map_err(|e| format!("Failed to run pip install: {}", e))?;

    if !install_result.status.success() {
        let stderr = String::from_utf8_lossy(&install_result.stderr);
        return Err(format!("Failed to install whisperx: {}", stderr));
    }

    log::info!("Successfully installed whisperx in virtual environment");
    Ok(())
}

fn setup_whisperx_environment(system_python: &str) -> Result<PathBuf, String> {
    let venv_python = create_venv_if_needed(system_python)?;

    let check_output = Command::new(&venv_python)
        .args(["-c", "import whisperx; print('ok')"])
        .output();

    let whisperx_installed = check_output
        .map(|o| o.status.success() && String::from_utf8_lossy(&o.stdout).contains("ok"))
        .unwrap_or(false);

    if whisperx_installed {
        log::info!("WhisperX already installed in virtual environment");
        return Ok(venv_python);
    }

    install_whisperx_in_venv(&venv_python)?;
    Ok(venv_python)
}

#[derive(Debug, Deserialize)]
struct WhisperXWord {
    word: String,
    start: Option<f64>,
    end: Option<f64>,
}

#[derive(Debug, Deserialize)]
struct WhisperXSegment {
    start: f64,
    end: f64,
    text: String,
    #[serde(default)]
    words: Vec<WhisperXWord>,
}

#[derive(Debug, Deserialize)]
struct WhisperXOutput {
    segments: Vec<WhisperXSegment>,
}

fn get_model_size_from_path(model_path: &str) -> &str {
    if model_path.contains("large") {
        "large-v3"
    } else if model_path.contains("medium") {
        "medium"
    } else if model_path.contains("small") {
        "small"
    } else if model_path.contains("base") {
        "base"
    } else {
        "tiny"
    }
}

#[tauri::command]
#[specta::specta]
#[instrument]
pub async fn prewarm_whisperx(model_path: String) -> Result<bool, String> {
    if !std::path::Path::new(&model_path).exists() {
        log::info!("No model downloaded, skipping WhisperX pre-warm");
        return Ok(false);
    }

    let system_python = match find_python() {
        Some(p) => p,
        None => {
            log::info!("Python not found, skipping WhisperX pre-warm");
            return Ok(false);
        }
    };

    let venv_python = match setup_whisperx_environment(&system_python) {
        Ok(p) => p,
        Err(e) => {
            log::info!("WhisperX environment not ready: {}, skipping pre-warm", e);
            return Ok(false);
        }
    };

    let model_size = get_model_size_from_path(&model_path).to_string();

    log::info!(
        "Pre-warming WhisperX server with model size: {}",
        model_size
    );

    tokio::task::spawn_blocking(move || {
        let mut server_guard = WHISPERX_SERVER.blocking_lock();

        if server_guard.is_some() {
            log::info!("WhisperX server already running, pre-warm not needed");
            return;
        }

        match start_whisperx_server(&venv_python, &model_size) {
            Ok(server) => {
                log::info!(
                    "WhisperX server pre-warmed successfully - transcriptions will be fast!"
                );
                *server_guard = Some(server);
            }
            Err(e) => {
                log::warn!("Failed to pre-warm WhisperX server: {}", e);
            }
        }
    });

    Ok(true)
}

#[tauri::command]
#[specta::specta]
#[instrument]
pub async fn transcribe_audio(
    video_path: String,
    model_path: String,
    language: String,
) -> Result<CaptionData, String> {
    log::info!("=== TRANSCRIBE AUDIO COMMAND START ===");
    log::info!("Video path: {}", video_path);
    log::info!("Model path: {}", model_path);
    log::info!("Language: {}", language);

    if !std::path::Path::new(&video_path).exists() {
        log::error!("Video file not found at path: {}", video_path);
        return Err(format!("Video file not found at path: {video_path}"));
    }

    if !std::path::Path::new(&model_path).exists() {
        log::error!("Model file not found at path: {}", model_path);
        return Err(format!("Model file not found at path: {model_path}"));
    }

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
        log::error!("Audio file was not created at {:?}", audio_path);
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

    let model_size = get_model_size_from_path(&model_path);
    log::info!("Detected model size: {}", model_size);

    if let Some(system_python) = find_python() {
        log::info!("Found system Python at: {}", system_python);

        match setup_whisperx_environment(&system_python) {
            Ok(venv_python) => {
                let audio_path_clone = audio_path.clone();
                let language_clone = language.clone();
                let model_size_clone = model_size.to_string();
                let venv_python_clone = venv_python.clone();

                log::info!("Attempting to use persistent WhisperX server...");
                let whisperx_result = tokio::task::spawn_blocking(move || {
                    let mut server_guard = WHISPERX_SERVER.blocking_lock();

                    let need_new_server = match &*server_guard {
                        Some(server) => {
                            if server.model_size != model_size_clone {
                                log::info!(
                                    "Model size changed from {} to {}, restarting server",
                                    server.model_size,
                                    model_size_clone
                                );
                                true
                            } else {
                                false
                            }
                        }
                        None => true,
                    };

                    if need_new_server {
                        *server_guard = None;

                        match start_whisperx_server(&venv_python_clone, &model_size_clone) {
                            Ok(server) => {
                                log::info!("WhisperX server started successfully");
                                *server_guard = Some(server);
                            }
                            Err(e) => {
                                log::warn!("Failed to start WhisperX server: {}", e);
                                return Err(e);
                            }
                        }
                    } else {
                        log::info!("Reusing existing WhisperX server (models already loaded!)");
                    }

                    let result = if let Some(server) = server_guard.as_mut() {
                        transcribe_with_server(
                            server,
                            &audio_path_clone,
                            &model_size_clone,
                            &language_clone,
                        )
                    } else {
                        Err("Server not available".to_string())
                    };

                    if let Err(ref e) = result {
                        if is_server_communication_error(e) {
                            log::warn!(
                                "Server communication error detected, clearing dead server: {}",
                                e
                            );
                            *server_guard = None;
                        }
                    }

                    result
                })
                .await
                .map_err(|e| format!("WhisperX task panicked: {e}"));

                match whisperx_result {
                    Ok(Ok(captions)) => {
                        log::info!("=== TRANSCRIBE AUDIO RESULT (WhisperX) ===");
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
                            log::warn!("No caption segments were generated by WhisperX");
                        } else {
                            log::info!("=== TRANSCRIBE AUDIO COMMAND END (WhisperX success) ===");
                            return Ok(captions);
                        }
                    }
                    Ok(Err(e)) => {
                        log::warn!("WhisperX failed: {}. Falling back to built-in Whisper.", e);
                    }
                    Err(e) => {
                        log::warn!(
                            "WhisperX task error: {}. Falling back to built-in Whisper.",
                            e
                        );
                    }
                }
            }
            Err(e) => {
                log::warn!(
                    "Failed to setup WhisperX environment: {}. Falling back to built-in Whisper.",
                    e
                );
            }
        }
    } else {
        log::info!("Python not found, using built-in Whisper");
    }

    log::info!("Using built-in Whisper for transcription");

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

    let audio_path_clone = audio_path.clone();
    let language_clone = language.clone();
    log::info!("Starting Whisper transcription in blocking task...");
    let whisper_result = tokio::task::spawn_blocking(move || {
        process_with_whisper(&audio_path_clone, context, &language_clone)
    })
    .await
    .map_err(|e| format!("Whisper task panicked: {e}"))?;

    match whisper_result {
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
                    let bold = settings_obj
                        .get("bold")
                        .and_then(|v| v.as_bool())
                        .unwrap_or(false);
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
                        highlight_color,
                        fade_duration,
                        linger_duration,
                        word_transition_duration,
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

impl DownloadProgress {
    const EVENT_NAME: &'static str = "download-progress";
}

#[tauri::command]
#[specta::specta]
#[instrument(skip(window))]
pub async fn download_whisper_model(
    app: AppHandle,
    window: Window,
    model_name: String,
    output_path: String,
) -> Result<(), String> {
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

    if let Some(parent) = std::path::Path::new(&output_path).parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create parent directories: {e}"))?;
    }
    let mut file = tokio::fs::File::create(&output_path)
        .await
        .map_err(|e| format!("Failed to create file: {e}"))?;

    let mut downloaded = 0;
    let mut bytes = response
        .bytes()
        .await
        .map_err(|e| format!("Failed to get response bytes: {e}"))?;

    const CHUNK_SIZE: usize = 1024 * 1024;
    while !bytes.is_empty() {
        let chunk_size = std::cmp::min(CHUNK_SIZE, bytes.len());
        let chunk = bytes.split_to(chunk_size);

        file.write_all(&chunk)
            .await
            .map_err(|e| format!("Error while writing to file: {e}"))?;

        downloaded += chunk_size as u64;

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

    file.flush()
        .await
        .map_err(|e| format!("Failed to flush file: {e}"))?;

    Ok(())
}

#[tauri::command]
#[specta::specta]
#[instrument]
pub async fn check_model_exists(model_path: String) -> Result<bool, String> {
    Ok(std::path::Path::new(&model_path).exists())
}

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
