pub fn peaks(blocks: &[&[f32]], channels: u16) -> Vec<f32> {
    cap_audio::waveform_peaks_from_slices(blocks, channels, cap_audio::AudioData::SAMPLE_RATE)
}
