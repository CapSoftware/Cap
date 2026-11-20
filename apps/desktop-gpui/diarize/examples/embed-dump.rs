//! Feature parity, speed and memory checks for the speaker model.
//!
//! embed-dump fbank <raw f32 file> <povey|hamming> <scale> <mean 0|1>
//! embed-dump embed <model.onnx> <raw f32 file> <window samples>...
//! embed-dump bench <model.onnx> <raw f32 file> <window samples> <batch> <rounds>
//! embed-dump shapes <model.onnx> <raw f32 file> <step samples>
//! embed-dump segments <model.onnx> <raw f32 file> <count>
//!
//! fbank and embed print JSON (the feature matrix, or one embedding per
//! window cut from the start of the file). bench prints milliseconds per
//! window (FRESH copies each input first). shapes and segments print resident
//! memory while embedding many input lengths, or random stretches of audio
//! (SHORT, FIXED_START, SLICE_ONLY narrow down what drives growth).

use std::path::Path;

use cap_diarize::fbank::{Fbank, Window};
use cap_diarize::{Embed, OnnxEmbedder};

fn read(path: &str) -> Vec<f32> {
    std::fs::read(path)
        .expect("read audio")
        .as_chunks::<4>()
        .0
        .iter()
        .map(|b| f32::from_le_bytes(*b))
        .collect()
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args[0] == "fbank" {
        let audio = read(&args[1]);
        let window = if args[2] == "hamming" {
            Window::Hamming
        } else {
            Window::Povey
        };
        let mut out = Vec::new();
        Fbank::new(window).compute(&audio, args[3].parse().unwrap(), args[4] == "1", &mut out);
        println!("{}", serde_json::to_string(&out).unwrap());
        return;
    }
    if args[0] == "segments" {
        let mut embedder = OnnxEmbedder::load(
            Path::new(&args[1]),
            1,
            std::env::var_os("OPTIMIZE").is_some(),
        )
        .expect("load model");
        let audio = read(&args[2]);
        let count: usize = args[3].parse().unwrap();
        let rss = || {
            std::process::Command::new("ps")
                .args(["-o", "rss=", "-p", &std::process::id().to_string()])
                .output()
                .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
                .unwrap_or_default()
        };
        let mut seed = 7u64;
        for i in 0..count {
            seed = seed.wrapping_mul(6_364_136_223_846_793_005).wrapping_add(1);
            let mut len = 24_000 + (seed >> 33) as usize % 360_000;
            let mut start = (seed >> 13) as usize % (audio.len() - len);
            if std::env::var_os("FIXED_START").is_some() {
                start = 0;
            }
            if std::env::var_os("SLICE_ONLY").is_some() {
                len = 24_000;
                let window = &audio[start..start + len];
                embedder.embed(&[window]).expect("embed");
                if i.is_multiple_of(10) {
                    println!("{i} segments rss {}", rss());
                }
                continue;
            }
            let segment: Vec<f32> = if std::env::var_os("REUSE").is_some() {
                audio[start..start + len]
                    .iter()
                    .map(|x| x * 1.0)
                    .collect::<Vec<f32>>()
            } else {
                audio[start..start + len].to_vec()
            };
            let segment = if std::env::var_os("SHORT").is_some() {
                segment[..segment.len().min(48_000)].to_vec()
            } else {
                segment
            };
            let windows: Vec<&[f32]> = (0..)
                .map(|k| k * 12_000)
                .take_while(|a| a + 24_000 <= segment.len())
                .map(|a| &segment[a..a + 24_000])
                .collect();
            embedder.embed(&windows).expect("embed");
            if i.is_multiple_of(10) {
                println!("{i} segments rss {}", rss());
            }
        }
        #[cfg(target_os = "macos")]
        {
            unsafe extern "C" {
                fn malloc_zone_pressure_relief(zone: *mut std::ffi::c_void, goal: usize) -> usize;
            }
            let freed = unsafe { malloc_zone_pressure_relief(std::ptr::null_mut(), 0) };
            println!("released {} MB, rss now {}", freed >> 20, rss());
        }
        return;
    }
    if args[0] == "shapes" {
        let mut embedder = OnnxEmbedder::load(
            Path::new(&args[1]),
            1,
            std::env::var_os("OPTIMIZE").is_some(),
        )
        .expect("load model");
        let audio = read(&args[2]);
        let step: usize = args[3].parse().unwrap();
        let rss = || {
            std::process::Command::new("ps")
                .args(["-o", "rss=", "-p", &std::process::id().to_string()])
                .output()
                .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
                .unwrap_or_default()
        };
        println!("start rss {}", rss());
        for (i, len) in (8_000..48_000).step_by(step).enumerate() {
            embedder.embed(&[&audio[..len]]).expect("embed");
            if i.is_multiple_of(50) {
                println!("{i} shapes rss {}", rss());
            }
        }
        for _ in 0..3 {
            for len in (8_000..48_000).step_by(step) {
                embedder.embed(&[&audio[..len]]).expect("embed");
            }
            println!("repeat rss {}", rss());
        }
        return;
    }
    if args[0] == "bench" {
        let mut embedder = OnnxEmbedder::load(
            Path::new(&args[1]),
            1,
            std::env::var_os("OPTIMIZE").is_some(),
        )
        .expect("load model");
        let audio = read(&args[2]);
        let len: usize = args[3].parse().unwrap();
        let batch: usize = args[4].parse().unwrap();
        let rounds: usize = args[5].parse().unwrap();
        let windows: Vec<&[f32]> = (0..batch)
            .map(|i| &audio[(i * len) % (audio.len() - len)..][..len])
            .collect();
        embedder.embed(&windows).expect("warm up");
        let started = std::time::Instant::now();
        let fresh = std::env::var_os("FRESH").is_some();
        for _ in 0..rounds {
            if fresh {
                let copies: Vec<Vec<f32>> = windows.iter().map(|w| w.to_vec()).collect();
                let views: Vec<&[f32]> = copies.iter().map(Vec::as_slice).collect();
                embedder.embed(&views).expect("embed");
            } else {
                embedder.embed(&windows).expect("embed");
            }
        }
        let ms = started.elapsed().as_secs_f64() * 1000.0 / (rounds * batch) as f64;
        let rss = std::process::Command::new("ps")
            .args(["-o", "rss=", "-p", &std::process::id().to_string()])
            .output()
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
            .unwrap_or_default();
        eprintln!("rss after {} windows: {rss} KB", rounds * batch);
        println!("{{\"msPerWindow\": {ms:.3}}}");
        return;
    }
    let mut embedder = OnnxEmbedder::load(
        Path::new(&args[1]),
        1,
        std::env::var_os("OPTIMIZE").is_some(),
    )
    .expect("load model");
    let audio = read(&args[2]);
    let mut out = Vec::new();
    for len in &args[3..] {
        let len: usize = len.parse().unwrap();
        out.extend(embedder.embed(&[&audio[..len]]).expect("embed"));
    }
    println!("{}", serde_json::to_string(&out).unwrap());
}
