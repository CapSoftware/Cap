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

// Renders a combination of audio tracks into a single stereo buffer
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
            .flat_map(|t| (t.data.samples().len() / t.data.channels() as usize).checked_sub(offset))
            .max()
            .unwrap_or(0),
    );

    for i in 0..samples {
        let mut left = 0.0;
        let mut right = 0.0;

        for track in tracks {
            let i = i.wrapping_add_signed(track.offset);

            let data = track.data;
            let gain = gain_for_db(track.gain);

            if gain == f32::NEG_INFINITY {
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

        out[out_offset + i * 2] = left;
        out[out_offset + i * 2 + 1] = right;
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
