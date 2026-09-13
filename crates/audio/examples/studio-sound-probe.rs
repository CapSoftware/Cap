use cap_audio::{
    AudioData, AudioSampleSource, AudioStream, ChunkRead, VOICE_PROFILE_SAMPLES, VoiceEnhancer,
    VoiceProfile, cast_f32_slice_to_bytes,
};
use std::{
    error::Error,
    io::{self, Write},
    path::{Path, PathBuf},
    sync::{Arc, atomic::AtomicBool},
    time::Instant,
};

struct Window {
    samples: Vec<f32>,
    start: usize,
    end: usize,
    channels: u16,
    complete: bool,
}

impl AudioSampleSource for Window {
    fn channels(&self) -> u16 {
        self.channels
    }

    fn sample_count(&self) -> usize {
        if self.complete { self.end } else { usize::MAX }
    }

    fn sample(&self, index: usize) -> Option<&f32> {
        self.samples
            .get(index.checked_sub(self.start * usize::from(self.channels))?)
    }
}

fn decode_original(path: &Path) -> Result<(), Box<dyn Error>> {
    let started = Instant::now();
    let mut source = AudioStream::open(path, Arc::new(AtomicBool::new(false)))?;
    let mut output = io::BufWriter::new(io::stdout().lock());
    let mut frames = 0;
    while let ChunkRead::Chunk(chunk) = source.read_chunk(12_000)? {
        frames += chunk.samples.len() / usize::from(chunk.channels);
        output.write_all(unsafe { cast_f32_slice_to_bytes(&chunk.samples) })?;
    }
    output.flush()?;
    eprintln!(
        "original_frames={frames} duration_secs={:.6} processing_secs={:.6}",
        frames as f64 / 48_000.0,
        started.elapsed().as_secs_f64()
    );
    Ok(())
}

fn main() -> Result<(), Box<dyn Error>> {
    let mut args = std::env::args_os().skip(1);
    let path = args.next().map(PathBuf::from).ok_or_else(|| {
        io::Error::other("Usage: studio-sound-probe INPUT [off|light|balanced|strong]; writes f32 PCM at 48 kHz to stdout")
    })?;
    ffmpeg::init()?;
    ffmpeg::log::set_level(ffmpeg::log::Level::Error);
    let strength = match args.next().as_deref().and_then(|value| value.to_str()) {
        Some("off") => return decode_original(&path),
        Some("light") => 0.7,
        None | Some("balanced") => 0.9,
        Some("strong") => 0.98,
        Some(value) => return Err(io::Error::other(format!("Unknown isolation: {value}")).into()),
    };
    let started = Instant::now();
    let seed =
        AudioData::from_file_range(&path, 0, VOICE_PROFILE_SAMPLES).map_err(io::Error::other)?;
    let profile = VoiceProfile::analyze(&seed);
    let channels = seed.channels();
    drop(seed);
    let calibration_ms = started.elapsed().as_secs_f64() * 1000.0;
    let mut enhancer = VoiceEnhancer::with_settings(channels, strength, profile);
    let mut stream = AudioStream::open(&path, Arc::new(AtomicBool::new(false)))?;
    let mut window = Window {
        samples: Vec::new(),
        start: 0,
        end: 0,
        channels,
        complete: false,
    };
    let mut cursor = 0;
    let mut peak_source_bytes = 0;
    let processing = Instant::now();
    let mut output = io::BufWriter::new(io::stdout().lock());
    loop {
        let range = enhancer.source_range(cursor, 4096);
        let discard = range
            .start
            .saturating_sub(window.start)
            .min(window.samples.len() / usize::from(channels));
        window.samples.drain(..discard * usize::from(channels));
        window.start += discard;
        while !window.complete && window.end < range.end {
            match stream.read_chunk(12_000)? {
                ChunkRead::Chunk(chunk) => {
                    let chunk_start = chunk.source_start_sample as usize;
                    let chunk_end = chunk_start + chunk.samples.len() / usize::from(channels);
                    if chunk.channels != channels || chunk_start != window.end {
                        return Err(io::Error::other("Discontinuous source audio").into());
                    }
                    let start = range.start.max(chunk_start).min(chunk_end);
                    if window.samples.is_empty() {
                        window.start = start;
                    }
                    window.samples.extend_from_slice(
                        &chunk.samples[(start - chunk_start) * usize::from(channels)..],
                    );
                    window.end = chunk_end;
                }
                ChunkRead::Eof { .. } => window.complete = true,
            }
        }
        peak_source_bytes = peak_source_bytes.max(window.samples.len() * 4);
        let audio = enhancer.render(&window, cursor, 4096);
        if audio.samples().is_empty() {
            break;
        }
        output.write_all(unsafe { cast_f32_slice_to_bytes(audio.samples()) })?;
        cursor += audio.samples().len() / usize::from(channels);
    }
    output.flush()?;
    eprintln!(
        "frames={cursor} channels={channels} duration_secs={:.6} calibration_ms={calibration_ms:.3} processing_secs={:.6} peak_source_bytes={peak_source_bytes} profile={profile:?}",
        cursor as f64 / 48_000.0,
        processing.elapsed().as_secs_f64()
    );
    Ok(())
}
