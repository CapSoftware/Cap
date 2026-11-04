use std::ops::Range;
use std::sync::Arc;

/// 5 ms hops: fine enough to land a cut between two syllables, coarse enough
/// that a two hour recording costs under 6 MB.
pub const HOP_SECONDS: f64 = 0.005;
const SAMPLE_RATE: f64 = 48_000.0;
pub const MIN_SILENCE: f64 = 0.2;
const DIGITAL_SILENCE_DB: f32 = -90.0;
const FLOOR_PERCENTILE: f64 = 0.02;
const SPEECH_PERCENTILE: f64 = 0.5;
const MIN_MARGIN_DB: f32 = 6.0;
const MAX_MARGIN_DB: f32 = 15.0;
const MIN_SEPARATION_DB: f32 = 2.0 * MIN_MARGIN_DB;

#[derive(Debug, Default)]
pub struct EnergyEnvelope {
    clips: Vec<Arc<[f32]>>,
    clip_offsets: Vec<f64>,
    thresholds: Vec<f32>,
    silences: Vec<Range<f64>>,
}

pub struct EnvelopeTrack<'a> {
    pub slices: Vec<&'a [f32]>,
    pub channels: u16,
    pub offset_seconds: f64,
}

pub fn clip_envelope(tracks: &[EnvelopeTrack<'_>], duration: f64) -> Vec<f32> {
    let hop = (HOP_SECONDS * SAMPLE_RATE).round() as i64;
    let hops = ((duration.max(0.0) * SAMPLE_RATE).ceil() as i64 + hop - 1) / hop;
    let mut sums = vec![0.0f64; hops.max(0) as usize];
    let mut counts = vec![0u32; sums.len()];
    for track in tracks {
        let channels = usize::from(track.channels.max(1));
        let offset = (track.offset_seconds * SAMPLE_RATE).round() as i64;
        let mut frame: i64 = 0;
        let mut channel = 0usize;
        let mut mixed = 0.0f64;
        'slices: for slice in &track.slices {
            for sample in *slice {
                mixed += f64::from(*sample);
                channel += 1;
                if channel < channels {
                    continue;
                }
                let source = frame - offset;
                frame += 1;
                channel = 0;
                let mono = mixed / channels as f64;
                mixed = 0.0;
                if source < 0 {
                    continue;
                }
                let index = (source / hop) as usize;
                if index >= sums.len() {
                    break 'slices;
                }
                sums[index] += mono * mono;
                counts[index] += 1;
            }
        }
    }
    let per_track = tracks.len().max(1) as f64;
    sums.iter()
        .zip(&counts)
        .map(|(sum, count)| {
            if *count == 0 {
                0.0
            } else {
                (sum / f64::from(*count) * per_track) as f32
            }
        })
        .collect()
}

impl EnergyEnvelope {
    pub fn new(clips: Vec<Vec<f32>>, recording_durations: &[f64]) -> Self {
        let clip_offsets = super::model::recording_offsets(recording_durations);
        let mut thresholds = Vec::with_capacity(clips.len());
        let mut silences = Vec::new();
        for (clip, offset) in clips.iter().zip(&clip_offsets) {
            let (threshold, runs) = clip_silences(clip);
            thresholds.push(threshold);
            silences.extend(runs.into_iter().map(|run| {
                offset + run.start as f64 * HOP_SECONDS..offset + run.end as f64 * HOP_SECONDS
            }));
        }
        Self {
            clip_offsets,
            clips: clips.into_iter().map(Arc::from).collect(),
            thresholds,
            silences,
        }
    }

    pub fn silences(&self) -> &[Range<f64>] {
        &self.silences
    }

    pub fn silences_overlapping(&self, range: Range<f64>) -> &[Range<f64>] {
        let first = self
            .silences
            .partition_point(|silence| silence.end <= range.start);
        let last = self
            .silences
            .partition_point(|silence| silence.start < range.end);
        &self.silences[first..last.max(first)]
    }

    pub fn silence_threshold_db(&self, source: f64) -> Option<f32> {
        let (clip, _) = self.locate(source)?;
        self.thresholds.get(clip).copied()
    }

    pub fn is_empty(&self) -> bool {
        self.clips.iter().all(|clip| clip.is_empty())
    }

    fn locate(&self, source: f64) -> Option<(usize, f64)> {
        let clip = self
            .clip_offsets
            .partition_point(|offset| *offset <= source)
            .checked_sub(1)?;
        Some((clip, source - self.clip_offsets[clip]))
    }

    pub fn energy_at(&self, source: f64) -> Option<f32> {
        let (clip, local) = self.locate(source)?;
        if local < 0.0 {
            return None;
        }
        self.clips
            .get(clip)?
            .get((local / HOP_SECONDS) as usize)
            .copied()
    }

    pub fn smoothed_db(&self, source: f64) -> Option<f32> {
        let mut total = 0.0;
        let mut count = 0;
        for step in [-1.0, 0.0, 1.0] {
            if let Some(energy) = self.energy_at(source + step * HOP_SECONDS) {
                total += energy;
                count += 1;
            }
        }
        (count > 0).then(|| 10.0 * (total / count as f32 + 1e-10).log10())
    }
}

fn to_db(energy: f32) -> f32 {
    10.0 * (energy + 1e-10).log10()
}

fn from_db(db: f32) -> f32 {
    10f32.powf(db / 10.0)
}

fn percentile(values: &mut [f32], fraction: f64) -> f32 {
    let index = ((values.len() - 1) as f64 * fraction).round() as usize;
    *values
        .select_nth_unstable_by(index, |a, b| a.total_cmp(b))
        .1
}

fn silence_threshold(smoothed: &[f32], window: usize) -> f32 {
    if smoothed.is_empty() {
        return DIGITAL_SILENCE_DB;
    }
    let window = window.clamp(1, smoothed.len());
    let stride = (smoothed.len() / 250_000).max(1);
    let mut sums = Vec::with_capacity(smoothed.len() / stride + 1);
    let mut sum: f64 = smoothed[..window]
        .iter()
        .map(|energy| f64::from(*energy))
        .sum();
    for index in window..=smoothed.len() {
        if (index - window) % stride == 0 {
            sums.push((sum / window as f64) as f32);
        }
        if index < smoothed.len() {
            sum += f64::from(smoothed[index]) - f64::from(smoothed[index - window]);
        }
    }
    let floor = to_db(percentile(&mut sums, FLOOR_PERCENTILE).max(0.0));
    let louder = from_db(floor + MIN_MARGIN_DB);
    let mut hops: Vec<f32> = smoothed
        .iter()
        .step_by(stride)
        .copied()
        .filter(|energy| *energy > louder)
        .collect();
    if hops.is_empty() {
        return DIGITAL_SILENCE_DB;
    }
    let speech = to_db(percentile(&mut hops, SPEECH_PERCENTILE));
    if speech - floor < MIN_SEPARATION_DB {
        return DIGITAL_SILENCE_DB;
    }
    floor + ((speech - floor) * 0.5).clamp(MIN_MARGIN_DB, MAX_MARGIN_DB)
}

pub fn clip_silences(clip: &[f32]) -> (f32, Vec<Range<usize>>) {
    let smoothed: Vec<f32> = (0..clip.len())
        .map(|index| {
            let window = &clip[index.saturating_sub(1)..(index + 2).min(clip.len())];
            window.iter().sum::<f32>() / window.len() as f32
        })
        .collect();
    let min_hops = (MIN_SILENCE / HOP_SECONDS).round() as usize;
    let threshold = silence_threshold(&smoothed, min_hops);
    let quiet = from_db(threshold) - 1e-10;
    let mut runs = Vec::new();
    let mut start = None;
    for (index, energy) in smoothed.iter().enumerate() {
        match (start, *energy < quiet) {
            (None, true) => start = Some(index),
            (Some(from), false) => {
                if index - from >= min_hops {
                    runs.push(from..index);
                }
                start = None;
            }
            _ => {}
        }
    }
    if let Some(from) = start
        && smoothed.len() - from >= min_hops
    {
        runs.push(from..smoothed.len());
    }
    (threshold, runs)
}
