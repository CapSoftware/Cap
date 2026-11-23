#[cfg(target_os = "macos")]
fn main() {
    use std::{
        sync::{Arc, Mutex},
        time::Duration,
    };

    let seconds = std::env::args()
        .nth(1)
        .and_then(|value| value.parse().ok())
        .unwrap_or(5u64);
    println!(
        "supported={} permission={:?}",
        cap_meeting_platform::system_tap_supported(),
        cap_meeting_platform::audio_capture_permission()
    );

    #[derive(Default)]
    struct Stats {
        frames: u64,
        chunks: u64,
        peak: f32,
        energy: f64,
        sample_rate: u32,
        last_offset: u64,
    }
    let stats = Arc::new(Mutex::new(Stats::default()));
    let tap = cap_meeting_platform::SystemAudioTap::start(true, {
        let stats = stats.clone();
        move |chunk| {
            let mut stats = stats.lock().unwrap();
            stats.frames += chunk.samples.len() as u64;
            stats.chunks += 1;
            stats.sample_rate = chunk.sample_rate;
            stats.last_offset = chunk.frame_offset;
            for sample in chunk.samples {
                stats.peak = stats.peak.max(sample.abs());
                stats.energy += f64::from(*sample) * f64::from(*sample);
            }
        }
    })
    .expect("tap");

    for second in 1..=seconds {
        std::thread::sleep(Duration::from_secs(1));
        let stats = stats.lock().unwrap();
        let rms = if stats.frames > 0 {
            (stats.energy / stats.frames as f64).sqrt()
        } else {
            0.0
        };
        println!(
            "t={second}s frames={} chunks={} rate={} peak={:.4} rms={:.5} offset={} {:?}",
            stats.frames,
            stats.chunks,
            stats.sample_rate,
            stats.peak,
            rms,
            stats.last_offset,
            tap.stats()
        );
    }
    drop(tap);
    println!("stopped cleanly");
}

#[cfg(not(target_os = "macos"))]
fn main() {}
