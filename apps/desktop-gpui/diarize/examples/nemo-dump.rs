//! nemo-dump <model.onnx> <in.wav> <out.bin> [threads] [segment_s]: streams a wav through the crate's Nemotron path
//! (as one segment, or cut into `segment_s` pieces pushed back to back) and writes the 10 ms voice probabilities
//! (u8, 8 per frame) of the joined timeline, for comparison with the reference implementation.

use std::path::Path;
use std::time::Instant;

use cap_diarize::Track;
use cap_diarize::nemotron::{NemoRunner, OnnxNemotron};

/// 16 kHz mono PCM16 wav (the eval corpus format).
fn read_wav(path: &Path) -> Vec<f32> {
    let bytes = std::fs::read(path).expect("wav");
    let mut at = 12;
    while at + 8 <= bytes.len() {
        let len = u32::from_le_bytes(bytes[at + 4..at + 8].try_into().unwrap()) as usize;
        if &bytes[at..at + 4] == b"data" {
            let body = &bytes[at + 8..(at + 8 + len).min(bytes.len())];
            return body.chunks_exact(2).map(|c| i16::from_le_bytes([c[0], c[1]]) as f32 / 32768.0).collect();
        }
        at += 8 + len + (len & 1);
    }
    panic!("no data chunk")
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let threads: usize = args.get(3).map_or(2, |v| v.parse().unwrap());
    let seg_s: Option<f64> = args.get(4).map(|v| v.parse().unwrap());
    let samples = read_wav(Path::new(&args[1]));
    let model = OnnxNemotron::load(Path::new(&args[0]), threads).expect("model");
    let t = Instant::now();
    let runner = NemoRunner::start(Box::new(model));
    match seg_s {
        None => runner.push(Track::System, 0, &samples),
        Some(s) => {
            let n = (s * 16_000.0) as usize;
            for (k, chunk) in samples.chunks(n).enumerate() {
                runner.push(Track::System, (k * n / 16) as u64, chunk);
            }
        }
    }
    let [_, sys] = runner.finish().expect("voices");
    let secs = t.elapsed().as_secs_f64();
    std::fs::write(&args[2], sys.raw()).expect("write");
    eprintln!("frames {} voices {} wall {:.2}s audio {:.0}s", sys.frames(), sys.voices(), secs, samples.len() as f64 / 16_000.0);
}
