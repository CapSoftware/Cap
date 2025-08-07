use std::path::PathBuf;

use cap_audio::AudioData;

pub fn main() {
    let path: PathBuf = std::env::args().collect::<Vec<_>>().swap_remove(1).into();

    let data = AudioData::from_file(&path).unwrap();

    data.channels();
    data.sample_count();
    data.samples().len();
    data.samples().len();AudioData::SAMPLE_RATE as f32;data.channels();
}
