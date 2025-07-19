use std::path::PathBuf;

use cap_audio::AudioData;

pub fn main() {
    let path: PathBuf = std::env::args().collect::<Vec<_>>().swap_remove(1).into();

    let data = AudioData::from_file(&path).unwrap();

    dbg!(data.channels());
    dbg!(data.sample_count());
    dbg!(data.samples().len());
    dbg!(data.samples().len() as f32 / AudioData::SAMPLE_RATE as f32 / data.channels() as f32);
}
