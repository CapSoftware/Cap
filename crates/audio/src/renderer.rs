use crate::AudioData;

pub enum StereoMode {
    Stereo,
    MonoL,
    MonoR,
}

pub struct AudioRendererTrack<'a> {
    pub data: &'a AudioData,
    pub gain: f32,
    pub stereo_mode: StereoMode,
    pub offset: isize,
}

pub fn render_audio(
    tracks: &[AudioRendererTrack],
    offset: usize,
    samples: usize,
    out_offset: usize,
    out: &mut [f32],
) -> usize {
    let samples = samples.min(
        tracks
            .iter()
            .filter_map(|t| {
                let track_samples = t.data.samples().len() / t.data.channels() as usize;
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

    for i in 0..samples {
        let mut left = 0.0;
        let mut right = 0.0;

        for track in tracks {
            let source_index = offset as i128 + i as i128 + track.offset as i128;
            if source_index < 0 {
                continue;
            }
            let Ok(source_index) = usize::try_from(source_index) else {
                continue;
            };

            let data = track.data;
            let gain = gain_for_db(track.gain);

            if gain == f32::NEG_INFINITY {
                continue;
            }

            if data.channels() == 1 {
                if let Some(sample) = data.samples().get(source_index) {
                    left += sample * 0.707 * gain;
                    right += sample * 0.707 * gain;
                }
            } else if data.channels() == 2 {
                let base_idx = source_index.saturating_mul(2);
                let Some(l_sample) = data.samples().get(base_idx) else {
                    continue;
                };
                let Some(r_sample) = data.samples().get(base_idx + 1) else {
                    continue;
                };

                match track.stereo_mode {
                    StereoMode::Stereo => {
                        left += l_sample * gain;
                        right += r_sample * gain;
                    }
                    StereoMode::MonoL => {
                        left += l_sample * gain;
                        right += l_sample * gain;
                    }
                    StereoMode::MonoR => {
                        left += r_sample * gain;
                        right += r_sample * gain;
                    }
                }
            }
        }

        let l = left.clamp(-1.0, 1.0);
        let r = right.clamp(-1.0, 1.0);
        out[out_offset + i * 2] = l;
        out[out_offset + i * 2 + 1] = r;
    }

    samples
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
