use crate::AudioData;

#[derive(Clone, Copy)]
pub enum StereoMode {
    Stereo,
    MonoL,
    MonoR,
}

#[derive(Clone, Copy)]
pub struct AudioRendererTrack<'a> {
    pub data: &'a AudioData,
    pub linear_gain: f32,
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
    render_audio_from_tracks(tracks.iter().copied(), offset, samples, out_offset, out)
}

pub fn render_audio_from_tracks<'a>(
    tracks: impl Iterator<Item = AudioRendererTrack<'a>> + Clone,
    offset: usize,
    samples: usize,
    out_offset: usize,
    out: &mut [f32],
) -> usize {
    let samples = samples.min(
        tracks
            .clone()
            .filter_map(|t| {
                let track_samples = t.data.samples().len() / t.data.channels() as usize;
                let available = track_samples as isize - offset as isize - t.offset;
                if available > 0 {
                    Some(available as usize)
                } else {
                    None
                }
            })
            .max()
            .unwrap_or(0),
    );

    out[out_offset..out_offset + samples * 2].fill(0.0);

    for track in tracks {
        if track.linear_gain == 0.0 {
            continue;
        }

        let data = track.data;
        let data_samples = data.samples();
        let channels = data.channels() as usize;
        let track_samples = data_samples.len() / channels;
        let valid_range = valid_output_range(track_samples, offset, track.offset, samples);
        if valid_range.is_empty() {
            continue;
        }
        let source_start = (offset as isize + valid_range.start as isize + track.offset) as usize;
        let output_start = valid_range.start;
        let output_end = valid_range.end;

        let gain = track.linear_gain;

        if channels == 1 {
            for (src_i, i) in (source_start..).zip(output_start..output_end) {
                let sample = data_samples[src_i] * 0.707 * gain;
                out[out_offset + i * 2] += sample;
                out[out_offset + i * 2 + 1] += sample;
            }
        } else if channels == 2 {
            match track.stereo_mode {
                StereoMode::Stereo => {
                    let mut base_idx = source_start * 2;
                    for i in output_start..output_end {
                        let l_sample = data_samples[base_idx];
                        let r_sample = data_samples[base_idx + 1];
                        out[out_offset + i * 2] += l_sample * gain;
                        out[out_offset + i * 2 + 1] += r_sample * gain;
                        base_idx += 2;
                    }
                }
                StereoMode::MonoL => {
                    let mut base_idx = source_start * 2;
                    for i in output_start..output_end {
                        let l_sample = data_samples[base_idx];
                        out[out_offset + i * 2] += l_sample * gain;
                        out[out_offset + i * 2 + 1] += l_sample * gain;
                        base_idx += 2;
                    }
                }
                StereoMode::MonoR => {
                    let mut base_idx = source_start * 2;
                    for i in output_start..output_end {
                        let r_sample = data_samples[base_idx + 1];
                        out[out_offset + i * 2] += r_sample * gain;
                        out[out_offset + i * 2 + 1] += r_sample * gain;
                        base_idx += 2;
                    }
                }
            }
        }
    }

    for i in 0..samples {
        let left_index = out_offset + i * 2;
        let right_index = left_index + 1;
        let left = out[left_index];
        let right = out[right_index];
        let l = left.clamp(-1.0, 1.0);
        let r = right.clamp(-1.0, 1.0);
        out[left_index] = l;
        out[right_index] = r;
    }

    samples
}

fn valid_output_range(
    track_samples: usize,
    offset: usize,
    track_offset: isize,
    samples: usize,
) -> std::ops::Range<usize> {
    let start = if track_offset < 0 {
        track_offset.unsigned_abs().saturating_sub(offset)
    } else {
        0
    };
    let end = track_samples as isize - offset as isize - track_offset;
    let end = if end <= 0 {
        0
    } else {
        (end as usize).min(samples)
    };

    start.min(end)..end
}

pub fn linear_gain_for_db(db: f32) -> f32 {
    match db {
        v if v <= -30.0 => 0.0,
        v => db_to_linear(v),
    }
}
fn db_to_linear(db: f32) -> f32 {
    10.0_f32.powf(db / 20.0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{hint::black_box, time::Instant};

    struct BaselineAudioRendererTrack<'a> {
        data: &'a AudioData,
        gain_db: f32,
        stereo_mode: StereoMode,
        offset: isize,
    }

    fn assert_close(actual: f32, expected: f32) {
        assert!((actual - expected).abs() < 0.000_01);
    }

    fn render_audio_baseline(
        tracks: &[BaselineAudioRendererTrack],
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
                    let available = track_samples as isize - offset as isize - t.offset;
                    if available > 0 {
                        Some(available as usize)
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
                let i = i.wrapping_add_signed(track.offset);

                let data = track.data;
                let gain = linear_gain_for_db(track.gain_db);

                if gain == 0.0 {
                    continue;
                }

                if data.channels() == 1 {
                    if let Some(sample) = data.samples().get(offset + i) {
                        left += sample * 0.707 * gain;
                        right += sample * 0.707 * gain;
                    }
                } else if data.channels() == 2 {
                    let base_idx = offset * 2 + i * 2;
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

    #[test]
    fn render_audio_mixes_stereo_and_mono_tracks() {
        let stereo = AudioData::from_samples(vec![0.5, -0.5, 0.25, -0.25], 2);
        let mono = AudioData::from_samples(vec![1.0, 0.5], 1);
        let tracks = [
            AudioRendererTrack {
                data: &stereo,
                linear_gain: linear_gain_for_db(0.0),
                stereo_mode: StereoMode::Stereo,
                offset: 0,
            },
            AudioRendererTrack {
                data: &mono,
                linear_gain: linear_gain_for_db(-6.0),
                stereo_mode: StereoMode::Stereo,
                offset: 0,
            },
        ];
        let mut out = vec![0.0; 4];

        let rendered = render_audio(&tracks, 0, 2, 0, &mut out);
        let mono_gain = 10.0_f32.powf(-6.0 / 20.0) * 0.707;

        assert_eq!(rendered, 2);
        assert_close(out[0], 0.5 + mono_gain);
        assert_close(out[1], -0.5 + mono_gain);
        assert_close(out[2], 0.25 + 0.5 * mono_gain);
        assert_close(out[3], -0.25 + 0.5 * mono_gain);
    }

    #[test]
    fn render_audio_writes_silence_for_muted_tracks() {
        let mono = AudioData::from_samples(vec![1.0, 0.5], 1);
        let tracks = [AudioRendererTrack {
            data: &mono,
            linear_gain: 0.0,
            stereo_mode: StereoMode::Stereo,
            offset: 0,
        }];
        let mut out = vec![1.0; 4];

        let rendered = render_audio(&tracks, 0, 2, 0, &mut out);

        assert_eq!(rendered, 2);
        assert_eq!(out, vec![0.0; 4]);
    }

    #[test]
    fn render_audio_matches_baseline_for_offsets_and_stereo_modes() {
        let stereo = AudioData::from_samples(
            (0..128)
                .map(|i| ((i % 29) as f32 / 28.0) * 2.0 - 1.0)
                .collect(),
            2,
        );
        let mono = AudioData::from_samples(
            (0..64)
                .map(|i| ((i % 17) as f32 / 16.0) * 2.0 - 1.0)
                .collect(),
            1,
        );

        for stereo_mode in [StereoMode::Stereo, StereoMode::MonoL, StereoMode::MonoR] {
            for (offset, stereo_offset, mono_offset, samples) in
                [(0, 0, 0, 24), (8, 6, 3, 24), (30, 5, 9, 40)]
            {
                let baseline_tracks = [
                    BaselineAudioRendererTrack {
                        data: &stereo,
                        gain_db: -4.0,
                        stereo_mode,
                        offset: stereo_offset,
                    },
                    BaselineAudioRendererTrack {
                        data: &mono,
                        gain_db: -9.0,
                        stereo_mode,
                        offset: mono_offset,
                    },
                ];
                let optimized_tracks = [
                    AudioRendererTrack {
                        data: &stereo,
                        linear_gain: linear_gain_for_db(-4.0),
                        stereo_mode,
                        offset: stereo_offset,
                    },
                    AudioRendererTrack {
                        data: &mono,
                        linear_gain: linear_gain_for_db(-9.0),
                        stereo_mode,
                        offset: mono_offset,
                    },
                ];
                let mut baseline_out = vec![9.0; samples * 2];
                let mut optimized_out = vec![9.0; samples * 2];

                let baseline_rendered =
                    render_audio_baseline(&baseline_tracks, offset, samples, 0, &mut baseline_out);
                let optimized_rendered =
                    render_audio(&optimized_tracks, offset, samples, 0, &mut optimized_out);

                assert_eq!(baseline_rendered, optimized_rendered);
                assert_eq!(
                    &baseline_out[..baseline_rendered * 2],
                    &optimized_out[..optimized_rendered * 2]
                );
            }
        }
    }

    #[test]
    fn render_audio_silences_negative_track_preroll() {
        let mono = AudioData::from_samples(vec![1.0, 0.5, -0.5, -1.0], 1);
        let tracks = [AudioRendererTrack {
            data: &mono,
            linear_gain: linear_gain_for_db(0.0),
            stereo_mode: StereoMode::Stereo,
            offset: -4,
        }];
        let mut out = vec![8.0; 12];

        let rendered = render_audio(&tracks, 0, 6, 0, &mut out);

        assert_eq!(rendered, 6);
        assert_eq!(&out[..8], &[0.0; 8]);
        assert_close(out[8], 0.707);
        assert_close(out[9], 0.707);
        assert_close(out[10], 0.5 * 0.707);
        assert_close(out[11], 0.5 * 0.707);
    }

    #[test]
    #[ignore]
    fn benchmark_render_audio_prepared_gain() {
        let frame_samples = 1600usize;
        let iterations = 1000usize;
        let stereo_samples = (0..frame_samples * 2)
            .map(|i| ((i % 97) as f32 / 96.0) * 2.0 - 1.0)
            .collect::<Vec<_>>();
        let mono_samples = (0..frame_samples)
            .map(|i| ((i % 53) as f32 / 52.0) * 2.0 - 1.0)
            .collect::<Vec<_>>();
        let stereo = AudioData::from_samples(stereo_samples, 2);
        let mono = AudioData::from_samples(mono_samples, 1);
        let baseline_tracks = [
            BaselineAudioRendererTrack {
                data: &stereo,
                gain_db: -4.0,
                stereo_mode: StereoMode::Stereo,
                offset: 0,
            },
            BaselineAudioRendererTrack {
                data: &mono,
                gain_db: -9.0,
                stereo_mode: StereoMode::Stereo,
                offset: 0,
            },
        ];
        let optimized_tracks = [
            AudioRendererTrack {
                data: &stereo,
                linear_gain: linear_gain_for_db(-4.0),
                stereo_mode: StereoMode::Stereo,
                offset: 0,
            },
            AudioRendererTrack {
                data: &mono,
                linear_gain: linear_gain_for_db(-9.0),
                stereo_mode: StereoMode::Stereo,
                offset: 0,
            },
        ];
        let mut baseline_out = vec![0.0; frame_samples * 2];
        let mut optimized_out = vec![0.0; frame_samples * 2];

        let baseline_start = Instant::now();
        let mut baseline_rendered = 0usize;
        for _ in 0..iterations {
            baseline_rendered += render_audio_baseline(
                &baseline_tracks,
                0,
                frame_samples,
                0,
                black_box(&mut baseline_out),
            );
        }
        let baseline_elapsed = baseline_start.elapsed();

        let optimized_start = Instant::now();
        let mut optimized_rendered = 0usize;
        for _ in 0..iterations {
            optimized_rendered += render_audio(
                &optimized_tracks,
                0,
                frame_samples,
                0,
                black_box(&mut optimized_out),
            );
        }
        let optimized_elapsed = optimized_start.elapsed();

        assert_eq!(baseline_rendered, optimized_rendered);
        assert_eq!(baseline_out, optimized_out);

        println!(
            "{{\"baseline_ms\":{},\"optimized_ms\":{},\"speedup\":{:.3}}}",
            baseline_elapsed.as_millis(),
            optimized_elapsed.as_millis(),
            baseline_elapsed.as_secs_f64() / optimized_elapsed.as_secs_f64()
        );
    }
}
