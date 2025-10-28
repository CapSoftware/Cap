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

pub use cap_project::{CaptionSegment, CaptionSettings};

fn clean_special_tokens(text: &str) -> String {
    let mut result = text.trim().to_string();

    while let Some(start) = result.find("[_") {
        if let Some(end) = result[start..].find(']') {
            result.replace_range(start..start + end + 1, "");
        } else {
            break;
        }
    }

    result.trim().to_string()
}

fn is_silence_marker(text: &str) -> bool {
    let cleaned = text.trim().to_lowercase();
    cleaned == "[pause]"
        || cleaned == "[silence]"
        || cleaned == "um..."
        || cleaned == "uh..."
        || cleaned == "[blank_audio]"
        || cleaned == "(silence)"
        || cleaned.starts_with("[_") && cleaned.ends_with("]")
        || cleaned.is_empty()
}

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

async fn extract_audio_from_video(video_path: &str, output_path: &PathBuf) -> Result<f32, String> {
    if video_path.ends_with(".cap") {
        let meta_path = std::path::Path::new(video_path).join("recording-meta.json");
        let meta_content = std::fs::read_to_string(&meta_path)
            .map_err(|e| format!("Failed to read recording metadata: {e}"))?;

        let meta: serde_json::Value = serde_json::from_str(&meta_content)
            .map_err(|e| format!("Failed to parse recording metadata: {e}"))?;

        let base_path = std::path::Path::new(video_path);
        let mut audio_sources = Vec::new();
        let mut earliest_audio_start = f32::MAX;

        if let Some(segments) = meta["segments"].as_array() {
            for segment in segments {
                if let Some(mic_start) = segment["mic"]["start_time"].as_f64() {
                    if segment["mic"]["path"].as_str().is_some() {
                        earliest_audio_start = earliest_audio_start.min(mic_start as f32);
                    }
                }

                if let Some(audio_start) = segment["audio"]["start_time"].as_f64() {
                    if segment["audio"]["path"].as_str().is_some() {
                        earliest_audio_start = earliest_audio_start.min(audio_start as f32);
                    }
                }

                if earliest_audio_start == f32::MAX {
                    if let Some(system_audio_start) = segment["system_audio"]["start_time"].as_f64()
                    {
                        if segment["system_audio"]["path"].as_str().is_some() {
                            earliest_audio_start =
                                earliest_audio_start.min(system_audio_start as f32);
                        }
                    }
                }

                if let Some(system_audio) = segment["system_audio"]["path"].as_str() {
                    audio_sources.push(base_path.join(system_audio));
                }

                if let Some(audio) = segment["audio"]["path"].as_str() {
                    audio_sources.push(base_path.join(audio));
                }
                if let Some(mic) = segment["mic"]["path"].as_str() {
                    audio_sources.push(base_path.join(mic));
                }
            }
        }

        if audio_sources.is_empty() {
            return Err("No audio sources found in the recording metadata".to_string());
        }

        let mut mixed_samples = Vec::new();
        let mut channel_count = 0;

        for source in audio_sources {
            match AudioData::from_file(&source) {
                Ok(audio) => {
                    if mixed_samples.is_empty() {
                        mixed_samples = audio.samples().to_vec();
                        channel_count = audio.channels() as usize;
                    } else {
                        if audio.channels() as usize != channel_count {
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
            mixed_samples = convert_to_mono(&mixed_samples, channel_count);
            channel_count = 1;
        }

        if mixed_samples.is_empty() {
            return Err("Failed to process any audio sources".to_string());
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

        let mut frame = ffmpeg::frame::Audio::new(
            avformat::Sample::I16(avformat::sample::Type::Packed),
            frame_size,
            ChannelLayout::MONO,
        );
        frame.set_rate(WHISPER_SAMPLE_RATE);

        if !mixed_samples.is_empty() && frame_size * channel_count > 0 {
            for (chunk_idx, chunk) in mixed_samples.chunks(frame_size * channel_count).enumerate() {
                if chunk_idx % 100 == 0 {}

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
                    Ok(_) => if chunk_idx % 100 == 0 {},
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

        let final_offset = if earliest_audio_start == f32::MAX {
            log::warn!("No audio timing information found in metadata, using 0 offset");
            0.0
        } else {
            earliest_audio_start
        };

        Ok(final_offset)
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

        Ok(0.0)
    }
}

async fn get_whisper_context(model_path: &str) -> Result<Arc<WhisperContext>, String> {
    let ctx = WhisperContext::new_with_params(model_path, WhisperContextParameters::default())
        .map_err(|e| format!("Failed to load Whisper model: {e}"))?;

    Ok(Arc::new(ctx))
}

fn process_with_whisper(
    audio_path: &PathBuf,
    context: Arc<WhisperContext>,
    language: &str,
    time_offset: f32,
) -> Result<CaptionData, String> {
    let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });

    params.set_translate(false);
    params.set_print_special(false);
    params.set_print_progress(false);
    params.set_print_realtime(false);
    params.set_token_timestamps(true);
    params.set_language(Some(if language == "auto" { "auto" } else { language }));
    params.set_max_len(i32::MAX);

    let mut audio_file = File::open(audio_path)
        .map_err(|e| format!("Failed to open audio file: {e} at path: {audio_path:?}"))?;
    let mut audio_data = Vec::new();
    audio_file
        .read_to_end(&mut audio_data)
        .map_err(|e| format!("Failed to read audio file: {e}"))?;

    let mut audio_data_f32 = Vec::new();
    for i in (0..audio_data.len()).step_by(2) {
        if i + 1 < audio_data.len() {
            let sample = i16::from_le_bytes([audio_data[i], audio_data[i + 1]]) as f32 / 32768.0;
            audio_data_f32.push(sample);
        }
    }

    if !audio_data_f32.is_empty() {}

    let mut state = context
        .create_state()
        .map_err(|e| format!("Failed to create Whisper state: {e}"))?;

    state
        .full(params, &audio_data_f32[..])
        .map_err(|e| format!("Failed to run Whisper transcription: {e}"))?;

    let num_segments = state
        .full_n_segments()
        .map_err(|e| format!("Failed to get number of segments: {e}"))?;

    let mut segments = Vec::new();

    for i in 0..num_segments {
        let text = state
            .full_get_segment_text(i)
            .map_err(|e| format!("Failed to get segment text: {}", e))?;

        let n_tokens = state
            .full_n_tokens(i)
            .map_err(|e| format!("Failed to get token count for segment {}: {}", i, e))?;

        let start_i64 = state
            .full_get_segment_t0(i)
            .map_err(|e| format!("Failed to get segment start time: {e}"))?;
        let end_i64 = state
            .full_get_segment_t1(i)
            .map_err(|e| format!("Failed to get segment end time: {e}"))?;

        let start_time = (start_i64 as f32) / 100.0 + time_offset;
        let end_time = (end_i64 as f32) / 100.0 + time_offset;

        let mut words = Vec::new();
        let text_trimmed = text.trim();

        if !text_trimmed.is_empty() && n_tokens > 0 {
            let mut current_word = String::new();
            let mut word_start_time: Option<f32> = None;

            for j in 0..n_tokens {
                if let Ok(token_text) = state.full_get_token_text(i, j) {
                    if let Ok(token_info) = state.full_get_token_data(i, j) {
                        let token_start = (token_info.t0 as f32) / 100.0 + time_offset;
                        let _token_end = (token_info.t1 as f32) / 100.0 + time_offset;

                        let is_special_token =
                            token_text.starts_with("[_") && token_text.ends_with("]");

                        if !is_special_token {
                            let is_word_boundary = token_text.starts_with(' ')
                                || token_text.starts_with('\n')
                                || (j == 0 && !current_word.is_empty());

                            if is_word_boundary && !current_word.is_empty() {
                                if let Some(start) = word_start_time {
                                    let cleaned_word = clean_special_tokens(&current_word);
                                    if !cleaned_word.is_empty() {
                                        words.push(cap_project::CaptionWord {
                                            text: cleaned_word,
                                            start,
                                            end: token_start,
                                        });
                                    }
                                }
                                current_word.clear();
                                word_start_time = None;
                            }

                            current_word.push_str(&token_text);

                            if word_start_time.is_none() {
                                word_start_time = Some(token_start);
                            }
                        }
                    }
                }
            }

            if !current_word.is_empty() {
                if let Some(start) = word_start_time {
                    let cleaned_word = clean_special_tokens(&current_word);
                    if !cleaned_word.is_empty() {
                        words.push(cap_project::CaptionWord {
                            text: cleaned_word,
                            start,
                            end: end_time,
                        });
                    }
                }
            }

            if words.is_empty() {
                let word_texts: Vec<&str> = text_trimmed.split_whitespace().collect();
                let segment_duration = end_time - start_time;

                if !word_texts.is_empty() {
                    let total_chars: usize = word_texts.iter().map(|w| w.len()).sum();
                    let mut current_time = start_time;

                    for word_text in word_texts.iter() {
                        let word_weight = word_text.len() as f32 / total_chars as f32;
                        let word_duration = segment_duration * word_weight;
                        let word_end = current_time + word_duration;

                        words.push(cap_project::CaptionWord {
                            text: word_text.to_string(),
                            start: current_time,
                            end: word_end,
                        });

                        current_time = word_end;
                    }
                }
            }
        }

        if !words.is_empty() {
            log::debug!("Word-level timestamps for segment {}:", i);
            for word in &words {
                log::debug!("  '{}': {:.2}s - {:.2}s", word.text, word.start, word.end);
            }
        }

        let trimmed_text = text.trim();
        if !trimmed_text.is_empty() && !is_silence_marker(trimmed_text) {
            segments.push(CaptionSegment {
                id: format!("segment-{i}"),
                start: start_time,
                end: end_time,
                text: trimmed_text.to_string(),
                words,
            });
        } else if is_silence_marker(trimmed_text) {
        }
    }

    let _original_segment_count = segments.len();
    let mut split_segments = Vec::new();

    let mut avg_word_duration = 0.0;
    let mut word_count = 0;
    for segment in &segments {
        for word in &segment.words {
            avg_word_duration += word.end - word.start;
            word_count += 1;
        }
    }
    if word_count > 0 {
        avg_word_duration /= word_count as f32;
    }

    let pause_threshold = avg_word_duration * 2.0;

    for (_seg_idx, segment) in segments.into_iter().enumerate() {
        let words = &segment.words;

        if words.len() <= 6 {
            split_segments.push(segment);
        } else {
            let mut chunks = Vec::new();
            let mut current_chunk = Vec::new();
            let mut last_word_end = 0.0;

            for (word_idx, word) in words.iter().enumerate() {
                let gap = if word_idx > 0 {
                    word.start - last_word_end
                } else {
                    0.0
                };

                let upcoming_words_rapid = if word_idx + 3 < words.len() {
                    let next_duration = words[word_idx + 3].end - word.start;
                    let next_word_count = 4.0;
                    (next_word_count / next_duration) > 3.5
                } else {
                    false
                };

                let max_chunk_size = if upcoming_words_rapid { 4 } else { 6 };
                let min_chunk_size = if upcoming_words_rapid { 2 } else { 3 };

                let should_split = current_chunk.len() >= max_chunk_size
                    || (current_chunk.len() >= min_chunk_size && gap > pause_threshold);

                if should_split && !current_chunk.is_empty() {
                    chunks.push(current_chunk.clone());
                    current_chunk.clear();
                }

                current_chunk.push(word.clone());
                last_word_end = word.end;
            }

            if !current_chunk.is_empty() {
                chunks.push(current_chunk);
            }

            for (chunk_idx, chunk) in chunks.iter().enumerate() {
                if chunk.is_empty() {
                    continue;
                }

                let chunk_text = chunk
                    .iter()
                    .map(|w| w.text.clone())
                    .collect::<Vec<_>>()
                    .join(" ");

                let chunk_start = chunk.first().unwrap().start;
                let chunk_end = chunk.last().unwrap().end;

                let chunk_duration = chunk_end - chunk_start;
                let words_per_second = chunk.len() as f32 / chunk_duration.max(0.1);

                let base_overlap: f32 = if words_per_second > 3.0 {
                    0.15
                } else if words_per_second > 2.0 {
                    0.25
                } else {
                    0.35
                };

                let prev_gap = if chunk_idx > 0 && chunks.len() > chunk_idx {
                    let prev_chunk = &chunks[chunk_idx - 1];
                    chunk_start - prev_chunk.last().unwrap().end
                } else {
                    0.0
                };

                let next_gap = if chunk_idx + 1 < chunks.len() {
                    let next_chunk = &chunks[chunk_idx + 1];
                    next_chunk.first().unwrap().start - chunk_end
                } else {
                    0.0
                };

                let start_overlap = if prev_gap > pause_threshold {
                    base_overlap.min(prev_gap / 2.0)
                } else {
                    base_overlap
                };

                let end_overlap = if next_gap > pause_threshold {
                    base_overlap.min(next_gap / 2.0)
                } else {
                    base_overlap
                };

                let adjusted_start = if chunk_idx == 0 {
                    (chunk_start - start_overlap * 0.5).max(0.0)
                } else {
                    (chunk_start - start_overlap).max(0.0)
                };

                let adjusted_end = if chunk_idx == chunks.len() - 1 {
                    chunk_end + end_overlap * 0.5
                } else {
                    chunk_end + end_overlap
                };

                let min_duration = 0.5 + (chunk.len() as f32 * 0.15);
                let actual_duration = adjusted_end - adjusted_start;

                let final_end = if actual_duration < min_duration {
                    adjusted_start + min_duration
                } else {
                    adjusted_end
                };

                log::debug!(
                    "Caption chunk {}: words={}, speed={:.1} w/s, overlap={:.3}s, duration={:.3}s, adjusted_times=[{:.3}s - {:.3}s]",
                    chunk_idx,
                    chunk.len(),
                    words_per_second,
                    base_overlap,
                    final_end - adjusted_start,
                    adjusted_start,
                    final_end
                );

                split_segments.push(CaptionSegment {
                    id: format!("{}-split-{}", segment.id, chunk_idx),
                    start: adjusted_start,
                    end: final_end,
                    text: chunk_text,
                    words: chunk.to_vec(),
                });
            }
        }
    }

    Ok(CaptionData {
        segments: split_segments,
        settings: Some(cap_project::CaptionSettings::default()),
    })
}

#[tauri::command]
#[specta::specta]
#[instrument]
pub async fn transcribe_audio(
    video_path: String,
    model_path: String,
    language: String,
) -> Result<CaptionData, String> {
    if !std::path::Path::new(&video_path).exists() {
        return Err(format!("Video file not found at path: {video_path}"));
    }

    if !std::path::Path::new(&model_path).exists() {
        return Err(format!("Model file not found at path: {model_path}"));
    }

    let temp_dir = tempdir().map_err(|e| format!("Failed to create temporary directory: {e}"))?;
    let audio_path = temp_dir.path().join("audio.wav");

    let time_offset = match extract_audio_from_video(&video_path, &audio_path).await {
        Ok(offset) => offset,
        Err(e) => {
            log::error!("Failed to extract audio: {e}");
            return Err(format!("Failed to extract audio from video: {e}"));
        }
    };

    let total_time_offset = time_offset;

    if !audio_path.exists() {
        return Err("Failed to create audio file for transcription".to_string());
    }

    let context = match get_whisper_context(&model_path).await {
        Ok(ctx) => ctx,
        Err(e) => {
            log::error!("Failed to initialize Whisper context: {e}");
            return Err(format!("Failed to initialize transcription model: {e}"));
        }
    };

    match process_with_whisper(&audio_path, context, &language, total_time_offset) {
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
                        segments.push(cap_project::CaptionSegment {
                            id: id.to_string(),
                            start: start as f32,
                            end: end as f32,
                            text: text.to_string(),
                            words: Vec::new(),
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
                        .unwrap_or("#FFFFFF")
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
                        .unwrap_or(true);
                    let italic = settings_obj
                        .get("italic")
                        .and_then(|v| v.as_bool())
                        .unwrap_or(false);
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

    let client = Client::new();
    let response = client
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

    let captions = match load_captions(video_id.clone(), app.clone()).await? {
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
