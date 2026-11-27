//! Waveform levels, computed once per export from whole audio files.
//!
//! A video chunk's worker only fetches the ends of each audio file (and the
//! byte ranges of the display video its frames decode), so levels analysed
//! there would be flat wherever the file wasn't fetched. The coordinator runs
//! `levels` on whole files instead and ships the result to every chunk.
//!
//! File layout: a little-endian u32 header length, a JSON header listing each
//! level track and its byte length, then the tracks' bytes in header order.

use crate::project::LoadedProject;
use anyhow::{Context, Result, bail};
use cap_rendering::{AudioBandLevels, AudioLevelSource, AudioLevelStore};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::path::{Path, PathBuf};

const MAX_HEADER_BYTES: usize = 1 << 20;

#[derive(Serialize, Deserialize)]
struct Header {
    recording: Vec<RecordingEntry>,
    timeline: Vec<TimelineEntry>,
}

#[derive(Serialize, Deserialize)]
struct RecordingEntry {
    clip: u32,
    source: String,
    bytes: usize,
}

#[derive(Serialize, Deserialize)]
struct TimelineEntry {
    path: String,
    bytes: usize,
}

#[derive(Deserialize)]
pub struct LevelsRequest {
    pub project: PathBuf,
    pub out: PathBuf,
}

/// Files under the project the levels read whole, relative to it.
pub fn inputs(project: &LoadedProject) -> Vec<String> {
    let mut paths: Vec<String> = cap_editor::waveform_level_inputs(
        &project.recording_meta,
        &project.studio_meta,
        &project.config,
    )
    .into_iter()
    .filter_map(|path| {
        path.strip_prefix(&project.recording_meta.project_path)
            .ok()
            .map(|relative| relative.to_string_lossy().into_owned())
    })
    .collect();
    paths.sort_unstable();
    paths.dedup();
    paths
}

pub async fn compute(project: &LoadedProject) -> AudioLevelStore {
    let legacy_log = std::fs::read_to_string(
        project
            .recording_meta
            .project_path
            .join("recording-logs.log"),
    )
    .ok();
    let repairs =
        cap_editor::segment_audio_timing_repairs(&project.studio_meta, legacy_log.as_deref());
    let store = AudioLevelStore::default();
    cap_editor::load_waveform_levels_into(
        &store,
        &project.recording_meta,
        &project.studio_meta,
        &project.config,
        &repairs,
    )
    .await;
    store
}

pub fn encode(store: &AudioLevelStore) -> Result<Vec<u8>> {
    let recording = store.recording_levels();
    let timeline = store.timeline_levels();
    let header = Header {
        recording: recording
            .iter()
            .map(|(clip, source, levels)| RecordingEntry {
                clip: *clip,
                source: source.name().to_string(),
                bytes: levels.as_bytes().len(),
            })
            .collect(),
        timeline: timeline
            .iter()
            .map(|(path, levels)| TimelineEntry {
                path: path.clone(),
                bytes: levels.as_bytes().len(),
            })
            .collect(),
    };
    let header = serde_json::to_vec(&header)?;
    let mut out = Vec::new();
    out.extend_from_slice(&u32::try_from(header.len())?.to_le_bytes());
    out.extend_from_slice(&header);
    for (_, _, levels) in &recording {
        out.extend_from_slice(levels.as_bytes());
    }
    for (_, levels) in &timeline {
        out.extend_from_slice(levels.as_bytes());
    }
    Ok(out)
}

pub fn decode(bytes: &[u8], store: &AudioLevelStore) -> Result<()> {
    let Some((length, rest)) = bytes.split_first_chunk::<4>() else {
        bail!("levels file is too short");
    };
    let length = u32::from_le_bytes(*length) as usize;
    if length > MAX_HEADER_BYTES || length > rest.len() {
        bail!("levels header is {length} bytes");
    }
    let (header, mut body) = rest.split_at(length);
    let header: Header = serde_json::from_slice(header).context("levels header")?;
    let mut take = |count: usize| -> Result<AudioBandLevels> {
        if count > body.len() {
            bail!("levels file ends early");
        }
        let (levels, rest) = body.split_at(count);
        body = rest;
        AudioBandLevels::from_bytes(levels.to_vec()).context("levels are not whole frames of bands")
    };
    for entry in &header.recording {
        let Some(source) = AudioLevelSource::from_name(&entry.source) else {
            bail!("unknown level source {}", entry.source);
        };
        store.set(entry.clip, source, take(entry.bytes)?);
    }
    for entry in &header.timeline {
        store.set_timeline_audio(&entry.path, take(entry.bytes)?);
    }
    if !body.is_empty() {
        bail!("levels file has {} trailing bytes", body.len());
    }
    Ok(())
}

pub fn load(path: &Path, store: &AudioLevelStore) -> Result<()> {
    let bytes = std::fs::read(path).with_context(|| format!("reading {}", path.display()))?;
    decode(&bytes, store)
}

pub async fn levels(request: LevelsRequest) -> Result<Value> {
    let project = LoadedProject::load(&request.project)?;
    let store = compute(&project).await;
    let bytes = encode(&store)?;
    std::fs::write(&request.out, &bytes)
        .with_context(|| format!("writing {}", request.out.display()))?;
    Ok(json!({
        "bytes": bytes.len(),
        "recording": store.recording_levels().len(),
        "timeline": store.timeline_levels().len(),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use cap_rendering::AUDIO_LEVEL_BANDS;

    const RATE: u32 = 48_000;

    fn write_wav(path: &Path, seconds: u32) {
        let samples = (0..RATE * seconds).map(|index| {
            let time = f64::from(index) / f64::from(RATE);
            (12_000.0 * (std::f64::consts::TAU * 330.0 * time).sin()) as i16
        });
        let data_size = RATE * seconds * 2;
        let mut bytes = Vec::with_capacity(44 + data_size as usize);
        bytes.extend_from_slice(b"RIFF");
        bytes.extend_from_slice(&(36 + data_size).to_le_bytes());
        bytes.extend_from_slice(b"WAVEfmt ");
        bytes.extend_from_slice(&16u32.to_le_bytes());
        bytes.extend_from_slice(&1u16.to_le_bytes());
        bytes.extend_from_slice(&1u16.to_le_bytes());
        bytes.extend_from_slice(&RATE.to_le_bytes());
        bytes.extend_from_slice(&(RATE * 2).to_le_bytes());
        bytes.extend_from_slice(&2u16.to_le_bytes());
        bytes.extend_from_slice(&16u16.to_le_bytes());
        bytes.extend_from_slice(b"data");
        bytes.extend_from_slice(&data_size.to_le_bytes());
        for sample in samples {
            bytes.extend_from_slice(&sample.to_le_bytes());
        }
        std::fs::write(path, bytes).unwrap();
    }

    fn waveform_project(waveform: bool) -> tempfile::TempDir {
        let directory = tempfile::tempdir().unwrap();
        std::fs::copy(
            Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/small.mp4"),
            directory.path().join("display.mp4"),
        )
        .unwrap();
        write_wav(&directory.path().join("mic.wav"), 12);
        std::fs::write(
            directory.path().join("recording-meta.json"),
            serde_json::to_vec(&json!({
                "pretty_name": "Waveform",
                "display": { "path": "display.mp4", "fps": 30 },
                "audio": { "path": "mic.wav" }
            }))
            .unwrap(),
        )
        .unwrap();
        let waveforms = if waveform {
            json!([{ "start": 0.0, "end": 12.0 }])
        } else {
            json!([])
        };
        std::fs::write(
            directory.path().join("project-config.json"),
            serde_json::to_vec(&json!({
                "timeline": {
                    "segments": [{ "timescale": 1.0, "start": 0.0, "end": 12.0 }],
                    "zoomSegments": [],
                    "waveformSegments": waveforms
                }
            }))
            .unwrap(),
        )
        .unwrap();
        directory
    }

    fn peak(levels: &AudioBandLevels, second: usize) -> u8 {
        let frame = second * 60;
        levels.as_bytes()[frame * AUDIO_LEVEL_BANDS..(frame + 1) * AUDIO_LEVEL_BANDS]
            .iter()
            .copied()
            .max()
            .unwrap()
    }

    #[tokio::test]
    async fn chunks_get_levels_from_the_whole_file_not_their_sparse_copy() {
        crate::init_engine().unwrap();
        let whole = waveform_project(true);
        let project = LoadedProject::load(whole.path()).unwrap();
        assert_eq!(inputs(&project), vec!["mic.wav".to_string()]);
        let out = whole.path().join("levels.bin");
        levels(LevelsRequest {
            project: whole.path().to_path_buf(),
            out: out.clone(),
        })
        .await
        .unwrap();
        let shipped = AudioLevelStore::default();
        load(&out, &shipped).unwrap();
        let shipped = shipped.get(0, AudioLevelSource::Mic).unwrap();
        assert!(peak(&shipped, 6) > 150, "a tone mid-file has levels");

        // What a video chunk's worker holds: only the first and last 256 KiB
        // of the audio file, zeros between (see baseFileSpecs "probe").
        let sparse = waveform_project(true);
        let path = sparse.path().join("mic.wav");
        let mut bytes = std::fs::read(&path).unwrap();
        let length = bytes.len();
        bytes[256 * 1024..length - 256 * 1024].fill(0);
        std::fs::write(&path, bytes).unwrap();
        let analysed = compute(&LoadedProject::load(sparse.path()).unwrap()).await;
        let analysed = analysed.get(0, AudioLevelSource::Mic).unwrap();
        assert_eq!(peak(&analysed, 6), 0, "the sparse copy is flat mid-file");
        assert_eq!(analysed.frame_count(), shipped.frame_count());

        let plain = waveform_project(false);
        assert!(inputs(&LoadedProject::load(plain.path()).unwrap()).is_empty());
        assert!(
            compute(&LoadedProject::load(plain.path()).unwrap())
                .await
                .is_empty()
        );
    }

    #[test]
    fn levels_round_trip_and_reject_bad_files() {
        let store = AudioLevelStore::default();
        store.set(
            0,
            AudioLevelSource::Mic,
            AudioBandLevels::from_bytes((0..64).collect()).unwrap(),
        );
        store.set(
            1,
            AudioLevelSource::Display,
            AudioBandLevels::from_bytes(vec![7; 32]).unwrap(),
        );
        store.set_timeline_audio(
            "assets/music.mp3",
            AudioBandLevels::from_bytes(vec![9; 96]).unwrap(),
        );
        let bytes = encode(&store).unwrap();
        let read = AudioLevelStore::default();
        decode(&bytes, &read).unwrap();
        assert_eq!(
            read.get(0, AudioLevelSource::Mic).unwrap().as_bytes(),
            (0..64).collect::<Vec<u8>>()
        );
        assert_eq!(
            read.get(1, AudioLevelSource::Display).unwrap().as_bytes(),
            vec![7; 32]
        );
        assert_eq!(
            read.timeline_audio("assets/music.mp3").unwrap().as_bytes(),
            vec![9; 96]
        );

        assert!(decode(&bytes[..bytes.len() - 1], &AudioLevelStore::default()).is_err());
        let mut longer = bytes.clone();
        longer.push(0);
        assert!(decode(&longer, &AudioLevelStore::default()).is_err());
        assert!(decode(&[0xff, 0xff, 0xff, 0xff], &AudioLevelStore::default()).is_err());
    }
}
