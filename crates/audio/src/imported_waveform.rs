use crate::{AudioStream, ChunkRead};
use std::{
    collections::hash_map::DefaultHasher,
    fs::{self, File},
    hash::{Hash, Hasher},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{Arc, OnceLock, atomic::AtomicBool},
    time::UNIX_EPOCH,
};

const MAGIC: &[u8; 8] = b"CAPWAVE2";
const SAMPLE_RATE: usize = crate::AudioData::SAMPLE_RATE as usize;
const SAMPLES_PER_PEAK: usize = SAMPLE_RATE / 10;
const MAX_CACHED_PEAKS: usize = 10_000_000;

pub fn imported_waveform_slots() -> &'static tokio::sync::Semaphore {
    static SLOTS: OnceLock<tokio::sync::Semaphore> = OnceLock::new();
    SLOTS.get_or_init(|| tokio::sync::Semaphore::new(2))
}

fn source_stamp(path: &Path) -> Result<(u64, u64, u32), String> {
    let metadata =
        fs::metadata(path).map_err(|error| format!("Cannot inspect audio source: {error}"))?;
    if !metadata.is_file() {
        return Err("Audio source is not a file".into());
    }
    let modified = metadata
        .modified()
        .map_err(|error| format!("Cannot inspect audio source time: {error}"))?
        .duration_since(UNIX_EPOCH)
        .map_err(|error| format!("Invalid audio source time: {error}"))?;
    Ok((metadata.len(), modified.as_secs(), modified.subsec_nanos()))
}

fn cache_path(project_root: &Path, source: &Path) -> PathBuf {
    let mut hasher = DefaultHasher::new();
    source.hash(&mut hasher);
    project_root
        .join("cache/waveforms")
        .join(format!("{:016x}.cawf", hasher.finish()))
}

fn read_cache(path: &Path, stamp: (u64, u64, u32)) -> Option<Arc<[u8]>> {
    let mut file = File::open(path).ok()?;
    let mut header = [0u8; 36];
    file.read_exact(&mut header).ok()?;
    if &header[..8] != MAGIC
        || u64::from_le_bytes(header[8..16].try_into().ok()?) != stamp.0
        || u64::from_le_bytes(header[16..24].try_into().ok()?) != stamp.1
        || u32::from_le_bytes(header[24..28].try_into().ok()?) != stamp.2
    {
        return None;
    }
    let count = u64::from_le_bytes(header[28..36].try_into().ok()?) as usize;
    if count > MAX_CACHED_PEAKS {
        return None;
    }
    let mut peaks = vec![0u8; count];
    file.read_exact(&mut peaks).ok()?;
    let mut trailing = [0u8; 1];
    if file.read(&mut trailing).ok()? != 0 {
        return None;
    }
    Some(peaks.into())
}

fn write_cache(path: &Path, stamp: (u64, u64, u32), peaks: &[u8]) -> Result<(), String> {
    let parent = path.parent().ok_or("Invalid waveform cache path")?;
    fs::create_dir_all(parent).map_err(|error| format!("Cannot create waveform cache: {error}"))?;
    static NEXT_TEMP: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let sequence = NEXT_TEMP.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let temporary = path.with_extension(format!("{}.{}.tmp", std::process::id(), sequence));
    let result = (|| {
        let mut file = File::create(&temporary)
            .map_err(|error| format!("Cannot write waveform cache: {error}"))?;
        file.write_all(MAGIC)
            .and_then(|_| file.write_all(&stamp.0.to_le_bytes()))
            .and_then(|_| file.write_all(&stamp.1.to_le_bytes()))
            .and_then(|_| file.write_all(&stamp.2.to_le_bytes()))
            .and_then(|_| file.write_all(&(peaks.len() as u64).to_le_bytes()))
            .and_then(|_| file.write_all(peaks))
            .and_then(|_| file.sync_all())
            .map_err(|error| format!("Cannot save waveform cache: {error}"))?;
        let finished = match fs::rename(&temporary, path) {
            Ok(()) => Ok(()),
            Err(_) if read_cache(path, stamp).is_some() => Ok(()),
            Err(_) if cfg!(windows) && path.exists() => {
                fs::remove_file(path).and_then(|_| fs::rename(&temporary, path))
            }
            Err(error) => Err(error),
        };
        finished.map_err(|error| format!("Cannot finish waveform cache: {error}"))
    })();
    if temporary.exists() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

fn quantize(mean: f32) -> u8 {
    if mean <= 0.0 || !mean.is_finite() {
        return 0;
    }
    let db = (20.0 * mean.log10()).clamp(-60.0, 0.0);
    ((db + 60.0) * (255.0 / 60.0)).round() as u8
}

fn decode_peaks(source: &Path, cancellation: Arc<AtomicBool>) -> Result<Vec<u8>, String> {
    let mut stream = match AudioStream::open_waveform(source, cancellation) {
        Ok(stream) => stream,
        Err(error) if error.stage == "stream" && error.detail == "No Stream" => {
            return Ok(Vec::new());
        }
        Err(error) => return Err(format!("Cannot decode imported audio: {error}")),
    };
    let mut peaks = Vec::new();
    let mut sum = 0.0_f32;
    let mut samples = 0usize;
    while let ChunkRead::Chunk(chunk) = stream
        .read_chunk(SAMPLE_RATE)
        .map_err(|error| format!("Cannot read imported audio: {error}"))?
    {
        for sample in chunk.samples {
            sum += sample.abs();
            samples += 1;
            if samples == SAMPLES_PER_PEAK {
                peaks.push(quantize(sum / samples as f32));
                sum = 0.0;
                samples = 0;
            }
        }
        if peaks.len() > MAX_CACHED_PEAKS {
            return Err("Imported audio is too long for a timeline waveform".into());
        }
    }
    if samples > 0 {
        peaks.push(quantize(sum / samples as f32));
    }
    Ok(peaks)
}

pub fn imported_waveform(
    project_root: &Path,
    relative_path: &str,
    cancellation: Arc<AtomicBool>,
) -> Result<Arc<[u8]>, String> {
    let project_root = fs::canonicalize(project_root)
        .map_err(|error| format!("Cannot open editor project: {error}"))?;
    let source = fs::canonicalize(project_root.join(relative_path))
        .map_err(|error| format!("Cannot open imported media: {error}"))?;
    if !source.starts_with(&project_root) {
        return Err("Imported media is outside the editor project".into());
    }
    let stamp = source_stamp(&source)?;
    let cache = cache_path(&project_root, &source);
    if let Some(peaks) = read_cache(&cache, stamp) {
        return Ok(peaks);
    }
    let peaks = decode_peaks(&source, cancellation)?;
    if source_stamp(&source)? != stamp {
        return Err("Imported media changed while its waveform was generated".into());
    }
    write_cache(&cache, stamp, &peaks)?;
    Ok(peaks.into())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn wav(path: &Path, samples: &[i16]) {
        let bytes = (samples.len() * 2) as u32;
        let mut out = Vec::new();
        out.extend_from_slice(b"RIFF");
        out.extend_from_slice(&(36 + bytes).to_le_bytes());
        out.extend_from_slice(b"WAVEfmt ");
        out.extend_from_slice(&16u32.to_le_bytes());
        out.extend_from_slice(&1u16.to_le_bytes());
        out.extend_from_slice(&1u16.to_le_bytes());
        out.extend_from_slice(&48_000u32.to_le_bytes());
        out.extend_from_slice(&96_000u32.to_le_bytes());
        out.extend_from_slice(&2u16.to_le_bytes());
        out.extend_from_slice(&16u16.to_le_bytes());
        out.extend_from_slice(b"data");
        out.extend_from_slice(&bytes.to_le_bytes());
        for sample in samples {
            out.extend_from_slice(&sample.to_le_bytes());
        }
        fs::write(path, out).unwrap();
    }

    #[test]
    fn waveform_cache_is_compact_and_invalidates_when_media_changes() {
        let project = tempfile::tempdir().unwrap();
        let source = project.path().join("music.wav");
        let mut samples = vec![0i16; 48_000];
        samples.extend(vec![20_000i16; 48_000]);
        wav(&source, &samples);
        let cancelled = Arc::new(AtomicBool::new(false));
        let first = imported_waveform(project.path(), "music.wav", cancelled.clone()).unwrap();
        assert_eq!(first.len(), 20);
        assert!(first[..10].iter().all(|value| *value == 0));
        assert!(first[10..].iter().all(|value| *value > 0));
        assert_eq!(
            imported_waveform(project.path(), "music.wav", cancelled.clone())
                .unwrap()
                .as_ref(),
            first.as_ref()
        );
        wav(&source, &vec![0i16; 96_000]);
        let changed = imported_waveform(project.path(), "music.wav", cancelled).unwrap();
        assert!(changed.iter().all(|value| *value == 0));

        let audible: Vec<i16> = (0..48_000)
            .map(|index| {
                (20_000.0 * (2.0 * std::f64::consts::PI * 8_000.0 * index as f64 / 48_000.0).sin())
                    as i16
            })
            .collect();
        wav(&source, &audible);
        let high_frequency = imported_waveform(
            project.path(),
            "music.wav",
            Arc::new(AtomicBool::new(false)),
        )
        .unwrap();
        assert_eq!(high_frequency.len(), 10);
        assert!(high_frequency.iter().all(|value| *value > 100));
    }
}
