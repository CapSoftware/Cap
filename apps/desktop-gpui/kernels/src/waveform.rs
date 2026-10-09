pub fn peaks(blocks: &[&[f32]], channels: u16) -> Vec<f32> {
    cap_audio::waveform_peaks(blocks.iter().flat_map(|block| block.iter()), channels)
}
