use std::sync::Arc;

/// 5 ms hops: fine enough to land a cut between two syllables, coarse enough
/// that a two hour recording costs under 6 MB.
pub const HOP_SECONDS: f64 = 0.005;
const SAMPLE_RATE: f64 = 48_000.0;

/// Short-term loudness of what playback actually plays, per recording clip:
/// the mean square of the mono mix of every audio track, with each track's
/// sync offset applied the way the audio renderer applies it.
#[derive(Debug, Default)]
pub struct EnergyEnvelope {
    clips: Vec<Arc<[f32]>>,
    clip_offsets: Vec<f64>,
}

/// One audio track of a recording clip: interleaved 48 kHz samples, their
/// channel count, and the offset the renderer reads them at (source sample
/// `n` plays data sample `n + offset`).
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
        Self {
            clip_offsets: super::model::recording_offsets(recording_durations),
            clips: clips.into_iter().map(Arc::from).collect(),
        }
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

    /// Mean square over the hop containing `source`, `None` outside the audio.
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

    /// Loudness around `source` in decibels, smoothed over three hops so a
    /// single quiet hop inside a word does not look like a gap.
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
