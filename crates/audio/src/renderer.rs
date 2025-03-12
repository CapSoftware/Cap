use crate::AudioData;

// Renders a combination of audio tracks into a single stereo buffer
pub fn render_audio(
    tracks: &[&AudioData],
    offset: usize,
    samples: usize,
    out_offset: usize,
    out: &mut [f32],
) -> usize {
    if tracks
        .iter()
        .any(|t| (t.samples().len() / t.channels() as usize) < offset)
    {
        return 0;
    }

    let samples = samples.min(
        tracks
            .iter()
            .map(|t| (t.samples().len() / t.channels() as usize) - offset)
            .min()
            .unwrap_or(usize::MAX),
    );

    for i in 0..samples {
        let mut left = 0.0;
        let mut right = 0.0;

        for track in tracks {
            if track.channels() == 1 {
                left += track.samples()[offset + i] * 0.707;
                right += track.samples()[offset + i] * 0.707;
            } else {
                left += track.samples()[offset * 2 + i * 2];
                right += track.samples()[offset * 2 + i * 2 + 1];
            }
        }

        out[out_offset + i * 2] = left;
        out[out_offset + i * 2 + 1] = right;
    }

    samples
}
