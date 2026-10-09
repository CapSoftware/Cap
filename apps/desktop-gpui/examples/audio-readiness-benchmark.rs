use std::{
    path::PathBuf,
    sync::{Arc, atomic::AtomicBool},
    time::Instant,
};

use cap_audio::{AudioData, AudioStream, ChunkRead};
use sha2::{Digest, Sha256};
use tokio::sync::watch;

fn main() -> anyhow::Result<()> {
    let path = std::env::args_os()
        .nth(1)
        .map(PathBuf::from)
        .ok_or_else(|| anyhow::anyhow!("Pass an audio path"))?;
    if std::env::var_os("CAP_BENCH_PROGRESSIVE_AUDIO").is_some() {
        return progressive_audio(path);
    }
    background_audio(path)
}

#[derive(Clone)]
struct PreviousAudioLoader {
    rx: watch::Receiver<Option<Result<Option<Arc<AudioData>>, String>>>,
}

impl PreviousAudioLoader {
    fn spawn(path: PathBuf, label: String) -> Self {
        let (tx, rx) = watch::channel(None);
        tokio::task::spawn_blocking(move || {
            let result = AudioData::from_file(&path)
                .map(|data| Some(Arc::new(data)))
                .map_err(|e| format!("{label} / {e}"));
            let _ = tx.send(Some(result));
        });
        Self { rx }
    }

    async fn get(&self) -> Result<Option<Arc<AudioData>>, String> {
        let mut rx = self.rx.clone();
        loop {
            if let Some(result) = rx.borrow_and_update().clone() {
                return result;
            }
            if rx.changed().await.is_err() {
                return Err("Audio load task was dropped".to_string());
            }
        }
    }
}

fn background_audio(path: PathBuf) -> anyhow::Result<()> {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?
        .block_on(async move {
            let started = Instant::now();
            let loader = PreviousAudioLoader::spawn(path.clone(), "benchmark".into());
            let full = loader
                .get()
                .await
                .map_err(anyhow::Error::msg)?
                .ok_or_else(|| anyhow::anyhow!("Missing decoded audio"))?;
            let full_ms = started.elapsed().as_secs_f64() * 1000.0;
            background_audio_report(path, full.as_ref(), full_ms)
        })
}

fn background_audio_report(path: PathBuf, full: &AudioData, full_ms: f64) -> anyhow::Result<()> {
    let full_hash = format!(
        "{:x}",
        Sha256::digest(unsafe { cap_audio::cast_f32_slice_to_bytes(full.samples()) })
    );
    let mix = mix_benchmark(full);
    let channels = usize::from(full.channels());
    let sample_frames = full.samples().len() / channels;
    let window_frames = AudioData::SAMPLE_RATE as usize * 2;
    let mut windows = Vec::new();
    let mut matches_reference = true;
    let streaming = if std::env::var_os("CAP_BENCH_STREAM_AUDIO").is_some() {
        let started = Instant::now();
        let mut stream = AudioStream::open(&path, Arc::new(AtomicBool::new(false)))?;
        let open_ms = started.elapsed().as_secs_f64() * 1000.0;
        let mut decode_ms = open_ms;
        let mut first_chunk_ms = None;
        let mut next_sample = 0usize;
        let mut maximum_chunk_bytes = 0usize;
        let mut streamed_hash = Sha256::new();
        loop {
            let read_started = Instant::now();
            let result = stream.read_chunk(12_000)?;
            decode_ms += read_started.elapsed().as_secs_f64() * 1000.0;
            match result {
                ChunkRead::Chunk(chunk) => {
                    first_chunk_ms.get_or_insert(decode_ms);
                    anyhow::ensure!(chunk.channels == full.channels(), "Channel count changed");
                    anyhow::ensure!(
                        chunk.source_start_sample == (next_sample / channels) as u64,
                        "Noncontiguous audio chunk"
                    );
                    let end = next_sample + chunk.samples.len();
                    let reference = full.samples().get(next_sample..end).ok_or_else(|| {
                        anyhow::anyhow!("Streaming decode exceeded full-track length")
                    })?;
                    anyhow::ensure!(
                        chunk
                            .samples
                            .iter()
                            .zip(reference)
                            .all(|(actual, expected)| { actual.to_bits() == expected.to_bits() }),
                        "Streaming samples differ at source sample {next_sample}"
                    );
                    let bytes = unsafe { cap_audio::cast_f32_slice_to_bytes(&chunk.samples) };
                    maximum_chunk_bytes = maximum_chunk_bytes.max(bytes.len());
                    streamed_hash.update(bytes);
                    next_sample = end;
                }
                ChunkRead::Eof { next_sample: end } => {
                    anyhow::ensure!(end == sample_frames as u64, "Streaming EOF differs");
                    anyhow::ensure!(
                        next_sample == full.samples().len(),
                        "Streaming audio is short"
                    );
                    break;
                }
            }
        }
        Some(serde_json::json!({
            "openMs": open_ms,
            "firstChunkMs": first_chunk_ms,
            "chunkDurationSeconds": 0.25,
            "decodeMsExcludingComparison": decode_ms,
            "maximumChunkBytes": maximum_chunk_bytes,
            "samplesSha256": format!("{:x}", streamed_hash.finalize()),
            "bitExact": true,
        }))
    } else {
        None
    };
    for start in [
        0,
        sample_frames / 2,
        sample_frames.saturating_sub(window_frames),
    ] {
        if std::env::var_os("CAP_BENCH_FULL_AUDIO_ONLY").is_some() {
            break;
        }
        let end = start.saturating_add(window_frames).min(sample_frames);
        let started = Instant::now();
        let range = AudioData::from_file_range(&path, start, end).map_err(anyhow::Error::msg)?;
        let elapsed_ms = started.elapsed().as_secs_f64() * 1000.0;
        let reference = &full.samples()[start * channels..end * channels];
        let sample_count_matches = range.samples().len() == reference.len();
        let maximum_difference = range
            .samples()
            .iter()
            .zip(reference)
            .map(|(actual, expected)| (actual - expected).abs())
            .fold(0.0_f32, f32::max);
        matches_reference &= sample_count_matches && maximum_difference <= 0.000_001;
        windows.push(serde_json::json!({
            "startSeconds": start as f64 / f64::from(AudioData::SAMPLE_RATE),
            "elapsedMs": elapsed_ms,
            "decodedBytes": std::mem::size_of_val(range.samples()),
            "expectedSamples": reference.len(),
            "actualSamples": range.samples().len(),
            "sampleCountMatches": sample_count_matches,
            "maximumSampleDifference": maximum_difference,
        }));
    }
    println!(
        "{}",
        serde_json::json!({
            "path": path,
            "mode": "background-baseline",
            "baselineMode": "spawn-blocking-watch-arc",
            "methodology": methodology(),
            "fullDecodeMs": full_ms,
            "fullDecodedBytes": std::mem::size_of_val(full.samples()),
            "fullSamplesSha256": full_hash,
            "durationSeconds": sample_frames as f64 / f64::from(AudioData::SAMPLE_RATE),
            "channels": full.channels(),
            "sampleFrames": sample_frames,
            "windows": windows,
            "streaming": streaming,
            "mix": mix,
        })
    );
    anyhow::ensure!(
        matches_reference,
        "Window decoding differs from full-track decoding"
    );
    Ok(())
}

fn progressive_audio(path: PathBuf) -> anyhow::Result<()> {
    use cap_audio::AudioSampleSource;

    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?
        .block_on(async move {
            let started = Instant::now();
            let loader = cap_audio::ProgressiveAudio::spawn(path.clone(), "benchmark".into());
            let window = loader
                .window(0..12_000)
                .await
                .map_err(anyhow::Error::msg)?
                .ok_or_else(|| anyhow::anyhow!("Missing decoded audio"))?;
            let first_window_ms = started.elapsed().as_secs_f64() * 1000.0;
            let progress = loader.progress();
            let audio = loader
                .get()
                .await
                .map_err(anyhow::Error::msg)?
                .ok_or_else(|| anyhow::anyhow!("Missing decoded audio"))?;
            let full_ms = started.elapsed().as_secs_f64() * 1000.0;
            let mut first_hash = Sha256::new();
            for index in 0..12_000.min(window.sample_count()) * usize::from(window.channels()) {
                first_hash.update(window.sample(index).unwrap().to_le_bytes());
            }
            let mut hash = Sha256::new();
            let mut decoded_bytes = 0;
            for samples in audio.sample_slices() {
                decoded_bytes += std::mem::size_of_val(samples);
                hash.update(unsafe { cap_audio::cast_f32_slice_to_bytes(samples) });
            }
            println!(
                "{}",
                serde_json::json!({
                    "path": path,
                    "mode": "progressive",
                    "methodology": methodology(),
                    "firstWindowMs": first_window_ms,
                    "readyFramesAtFirstWindow": progress.ready_frames,
                    "completeAtFirstWindow": progress.complete,
                    "fullDecodedAudioMs": full_ms,
                    "fullDecodedBytes": decoded_bytes,
                    "channels": audio.channels(),
                    "sampleFrames": audio.sample_count(),
                    "decodedSha256": format!("{:x}", hash.finalize()),
                    "firstWindowSha256": format!("{:x}", first_hash.finalize()),
                    "mix": mix_benchmark(audio.as_ref()),
                })
            );
            Ok(())
        })
}

fn methodology() -> serde_json::Value {
    serde_json::json!({
        "runtime": "tokio-current-thread",
        "decodeExecution": "spawn-blocking",
        "fullDecodeTimer": "before-loader-spawn-through-completed-get",
        "runtimeSetupIncluded": false,
        "hashingIncluded": false,
        "mixingIncluded": false,
        "renderer": "current-cap-audio",
        "mixTiming": "after-full-pcm-hash-before-stream-or-range-diagnostics",
    })
}

fn mix_benchmark(audio: &impl cap_audio::AudioSampleSource) -> Option<serde_json::Value> {
    if std::env::var_os("CAP_BENCH_MIX_AUDIO").is_none() || audio.sample_count() < 48_000 {
        return None;
    }
    let tracks = [cap_audio::AudioRendererTrack {
        data: audio,
        gain: -4.0,
        stereo_mode: cap_audio::StereoMode::Stereo,
        offset: 0,
    }];
    let mut output = vec![0.0_f32; 48_000 * 2 * 3];
    let started = Instant::now();
    for _ in 0..20 {
        for (range, start) in [0, audio.sample_count() / 2, audio.sample_count() - 48_000]
            .into_iter()
            .enumerate()
        {
            for offset in (0..48_000).step_by(1_024) {
                let count = 1_024.min(48_000 - offset);
                let written = cap_audio::render_audio(
                    &tracks,
                    start + offset,
                    count,
                    (range * 48_000 + offset) * 2,
                    &mut output,
                );
                assert_eq!(written, count);
            }
        }
        std::hint::black_box(output.as_slice());
    }
    let elapsed_ms = started.elapsed().as_secs_f64() * 1000.0;
    Some(serde_json::json!({
        "elapsedMs": elapsed_ms,
        "renderedSeconds": 60,
        "repetitions": 20,
        "outputBarrier": "after-each-repetition",
        "sha256": format!("{:x}", Sha256::digest(unsafe { cap_audio::cast_f32_slice_to_bytes(&output) })),
    }))
}
