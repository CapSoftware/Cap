use crate::AudioData;
use std::ops::Range;

pub enum StereoMode {
    Stereo,
    MonoL,
    MonoR,
}

pub trait AudioSampleSource {
    fn channels(&self) -> u16;
    fn sample_count(&self) -> usize;
    fn sample(&self, index: usize) -> Option<&f32>;
    fn sample_slice(&self, _range: Range<usize>) -> Option<&[f32]> {
        None
    }
}

impl AudioSampleSource for AudioData {
    fn channels(&self) -> u16 {
        self.channels()
    }

    fn sample_count(&self) -> usize {
        self.samples().len() / self.channels() as usize
    }

    fn sample(&self, index: usize) -> Option<&f32> {
        self.samples().get(index)
    }

    fn sample_slice(&self, range: Range<usize>) -> Option<&[f32]> {
        self.samples().get(range)
    }
}

pub struct AudioRendererTrack<'a, T: AudioSampleSource = AudioData> {
    pub data: &'a T,
    pub gain: f32,
    pub stereo_mode: StereoMode,
    pub offset: isize,
}

pub fn render_audio<T: AudioSampleSource>(
    tracks: &[AudioRendererTrack<'_, T>],
    offset: usize,
    samples: usize,
    out_offset: usize,
    out: &mut [f32],
) -> usize {
    let samples = samples.min(
        tracks
            .iter()
            .filter_map(|t| {
                let track_samples = t.data.sample_count();
                let available = track_samples as i128 - offset as i128 - t.offset as i128;
                if available > 0 {
                    usize::try_from(available).ok()
                } else {
                    None
                }
            })
            .max()
            .unwrap_or(0),
    );

    if samples == 0 {
        return 0;
    }
    let out = &mut out[out_offset..out_offset + samples * 2];
    out.fill(0.0);

    for track in tracks {
        let gain = gain_for_db(track.gain);
        if gain == f32::NEG_INFINITY {
            continue;
        }
        let source_start = offset as i128 + track.offset as i128;
        let skipped = usize::try_from((-source_start).max(0))
            .unwrap_or(usize::MAX)
            .min(samples);
        let Ok(first) = usize::try_from(source_start.max(0)) else {
            continue;
        };
        let count = (samples - skipped).min(track.data.sample_count().saturating_sub(first));
        if count == 0 {
            continue;
        }
        let output = &mut out[skipped * 2..(skipped + count) * 2];
        match track.data.channels() {
            1 => {
                if let Some(input) = track.data.sample_slice(first..first + count) {
                    for (sample, frame) in input.iter().zip(output.chunks_exact_mut(2)) {
                        frame[0] += sample * 0.707 * gain;
                        frame[1] += sample * 0.707 * gain;
                    }
                } else {
                    for (index, frame) in output.chunks_exact_mut(2).enumerate() {
                        if let Some(sample) = track.data.sample(first + index) {
                            frame[0] += sample * 0.707 * gain;
                            frame[1] += sample * 0.707 * gain;
                        }
                    }
                }
            }
            2 => {
                let input = first
                    .checked_mul(2)
                    .zip((first + count).checked_mul(2))
                    .and_then(|(start, end)| track.data.sample_slice(start..end));
                if let Some(input) = input {
                    for (sample, frame) in input.chunks_exact(2).zip(output.chunks_exact_mut(2)) {
                        mix_stereo(sample[0], sample[1], frame, &track.stereo_mode, gain);
                    }
                } else {
                    for (index, frame) in output.chunks_exact_mut(2).enumerate() {
                        let base = (first + index).saturating_mul(2);
                        let Some(left) = track.data.sample(base) else {
                            continue;
                        };
                        let Some(right) = base.checked_add(1).and_then(|i| track.data.sample(i))
                        else {
                            continue;
                        };
                        mix_stereo(*left, *right, frame, &track.stereo_mode, gain);
                    }
                }
            }
            _ => {}
        }
    }
    for sample in out {
        *sample = sample.clamp(-1.0, 1.0);
    }

    samples
}

fn mix_stereo(left: f32, right: f32, frame: &mut [f32], mode: &StereoMode, gain: f32) {
    let (left, right) = match mode {
        StereoMode::Stereo => (left, right),
        StereoMode::MonoL => (left, left),
        StereoMode::MonoR => (right, right),
    };
    frame[0] += left * gain;
    frame[1] += right * gain;
}

fn gain_for_db(db: f32) -> f32 {
    match db {
        // Fully mute when at minimum
        v if v <= -30.0 => f32::NEG_INFINITY,
        v => db_to_linear(v),
    }
}
fn db_to_linear(db: f32) -> f32 {
    10.0_f32.powf(db / 20.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Source<'a> {
        data: &'a AudioData,
        slices: bool,
    }

    #[test]
    fn empty_stereo_window_at_large_cursor_preserves_silence() {
        struct EmptyWindow;

        impl AudioSampleSource for EmptyWindow {
            fn channels(&self) -> u16 {
                2
            }

            fn sample_count(&self) -> usize {
                usize::MAX
            }

            fn sample(&self, _index: usize) -> Option<&f32> {
                None
            }
        }

        let mut output = [13.0_f32; 2];
        let tracks = [AudioRendererTrack {
            data: &EmptyWindow,
            gain: 0.0,
            offset: 0,
            stereo_mode: StereoMode::Stereo,
        }];
        assert_eq!(
            render_audio(&tracks, usize::MAX / 2 + 1, 1, 0, &mut output),
            1
        );
        assert_eq!(output, [0.0; 2]);
    }

    impl AudioSampleSource for Source<'_> {
        fn channels(&self) -> u16 {
            self.data.channels()
        }

        fn sample_count(&self) -> usize {
            self.data.sample_count()
        }

        fn sample(&self, index: usize) -> Option<&f32> {
            self.data.sample(index)
        }

        fn sample_slice(&self, range: Range<usize>) -> Option<&[f32]> {
            self.slices.then(|| self.data.sample_slice(range)).flatten()
        }
    }

    #[test]
    fn contiguous_and_indexed_mixing_preserve_sample_bits_and_output_bounds() {
        let data = [
            AudioData::from_raw_f32(vec![0.5, -0.75, 0.25, -0.5], 1),
            AudioData::from_raw_f32(vec![0.25, -0.5, 0.75, 0.125, -0.25, 0.5], 2),
            AudioData::from_raw_f32(vec![0.5, -0.75, -0.25, 0.25, 0.125, -0.5, 0.25, 0.75], 2),
        ];
        let expected = [
            1095761920, 1095761920, 1059061760, 3206545408, 1048576000, 1061158912, 1056243188,
            3189113880, 3197074670, 1046545956, 1043660276, 1043660276, 3199532532, 3199532532,
            1095761920, 1095761920, 1095761920, 1095761920,
        ];
        for slices in [false, true] {
            let sources = data.each_ref().map(|data| Source { data, slices });
            let tracks = [
                AudioRendererTrack {
                    data: &sources[0],
                    gain: 0.0,
                    offset: -2,
                    stereo_mode: StereoMode::Stereo,
                },
                AudioRendererTrack {
                    data: &sources[1],
                    gain: 0.0,
                    offset: 1,
                    stereo_mode: StereoMode::MonoR,
                },
                AudioRendererTrack {
                    data: &sources[2],
                    gain: 0.0,
                    offset: 0,
                    stereo_mode: StereoMode::Stereo,
                },
            ];
            let mut output = [13.0_f32; 18];
            assert_eq!(render_audio(&tracks, 0, 7, 2, &mut output), 6);
            assert_eq!(output.map(f32::to_bits), expected);
        }
    }

    fn track(data: &AudioData, offset: isize) -> AudioRendererTrack<'_> {
        AudioRendererTrack {
            data,
            gain: 0.0,
            stereo_mode: StereoMode::Stereo,
            offset,
        }
    }

    // The mix read index is `offset + i + track.offset`, so the cursor and the
    // per-track offset both move the source read position.
    #[test]
    fn reads_from_cursor_and_track_offset() {
        // Stereo ramp: frame k carries L = R = (k + 1) / 100.
        let mut samples = Vec::new();
        for k in 0..10 {
            let v = (k as f32 + 1.0) / 100.0;
            samples.push(v);
            samples.push(v);
        }
        let data = AudioData::from_raw_f32(samples, 2);

        let mut out = vec![0.0; 4 * 2];
        let rendered = render_audio(&[track(&data, 0)], 3, 4, 0, &mut out);
        assert_eq!(rendered, 4);
        // cursor 3 -> first output frame reads source frame 3 (value 0.04).
        assert!((out[0] - 0.04).abs() < 1e-6);
        assert!((out[2] - 0.05).abs() < 1e-6);

        let mut out = vec![0.0; 4 * 2];
        render_audio(&[track(&data, 2)], 3, 4, 0, &mut out);
        // cursor 3 + track offset 2 -> source frame 5 (value 0.06).
        assert!((out[0] - 0.06).abs() < 1e-6);
    }

    #[test]
    fn negative_offset_delays_track_with_leading_silence() {
        let mut samples = Vec::new();
        for k in 0..4 {
            let v = (k as f32 + 1.0) / 10.0;
            samples.push(v);
            samples.push(v);
        }
        let data = AudioData::from_raw_f32(samples, 2);

        let mut out = vec![0.0; 6 * 2];
        let rendered = render_audio(&[track(&data, -2)], 0, 6, 0, &mut out);

        assert_eq!(rendered, 6);
        assert_eq!(out[0], 0.0);
        assert_eq!(out[2], 0.0);
        assert!((out[4] - 0.1).abs() < 1e-6);
        assert!((out[10] - 0.4).abs() < 1e-6);
    }

    // Regression guard for commit 2a6dce7: render mixes up to the LONGEST track
    // and pads shorter tracks with silence (the `.max()` in render_audio). A
    // `.min()` here would truncate the mix to the shortest track.
    #[test]
    fn mixes_to_longest_track_padding_short_with_silence() {
        let long = AudioData::from_raw_f32(vec![0.5; 20], 2); // 10 stereo frames
        let short = AudioData::from_raw_f32(vec![0.25; 8], 2); // 4 stereo frames

        let mut out = vec![0.0; 10 * 2];
        let rendered = render_audio(&[track(&long, 0), track(&short, 0)], 0, 10, 0, &mut out);

        assert_eq!(
            rendered, 10,
            "must render up to the longest track, not the shortest"
        );
        // Frames 0..4 mix both tracks.
        assert!((out[0] - 0.75).abs() < 1e-6);
        assert!((out[3 * 2] - 0.75).abs() < 1e-6);
        // Frames 4..10: short track exhausted -> contributes silence, long track remains.
        assert!((out[4 * 2] - 0.5).abs() < 1e-6);
        assert!((out[9 * 2] - 0.5).abs() < 1e-6);
    }
}
