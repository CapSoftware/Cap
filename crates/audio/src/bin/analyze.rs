use std::path::PathBuf;

use cap_audio::AudioData;

pub fn main() {
    let path: PathBuf = std::env::args().collect::<Vec<_>>().swap_remove(1).into();

    let data = AudioData::from_file(&path).unwrap();

    println!("Channels: {}", data.channels());
    println!("Sample count: {}", data.sample_count());
    println!("Samples len: {}", data.samples().len());
    println!("Sample Rate: {}", AudioData::SAMPLE_RATE as f32);
    println!("Channels: {}", data.channels());
}
