//! Probe playback time fidelity of the editor's video decoder on a real
//! recording: sequentially "play" the file like the preview does, hashing the
//! frame served at probe times, then compare against a fresh decoder asked for
//! the same times cold. Divergence = the streaming path served content for a
//! different time than requested.
//!
//! Usage: probe_sync <video.mp4> <fps> [ffmpeg] [paced]

use std::path::PathBuf;
use std::time::{Duration, Instant};

fn fnv(data: &[u8]) -> u64 {
    // sample the buffer sparsely: hashing 33MB per frame x 51k frames is slow
    let mut h: u64 = 0xcbf29ce484222325;
    let step = (data.len() / 4096).max(1);
    let mut i = 0;
    while i < data.len() {
        h ^= data[i] as u64;
        h = h.wrapping_mul(0x100000001b3);
        i += step;
    }
    h ^= data.len() as u64;
    h
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .with_writer(std::io::stderr)
        .init();
    let mut args = std::env::args().skip(1);
    let path = PathBuf::from(args.next().expect("video path"));
    let fps: u32 = args.next().expect("fps").parse().unwrap();
    let rest: Vec<String> = args.collect();
    let force_ffmpeg = rest.iter().any(|a| a == "ffmpeg");
    let paced = rest.iter().any(|a| a == "paced");
    let noref = rest.iter().any(|a| a == "noref");

    let out_fps = 60u32;
    let probe_every_secs = 10.0f64;

    let duration = {
        let input = ffmpeg::format::input(&path).unwrap();
        let stream = input.streams().best(ffmpeg::media::Type::Video).unwrap();
        let tb = stream.time_base();
        stream.duration() as f64 * tb.numerator() as f64 / tb.denominator() as f64
    };
    eprintln!("duration: {duration:.3}s, force_ffmpeg={force_ffmpeg}, paced={paced}");

    let streaming =
        cap_rendering::decoder::spawn_decoder("probe-stream", path.clone(), fps, 0.0, force_ffmpeg)
            .await
            .expect("spawn streaming decoder");

    let total_out_frames = (duration * out_fps as f64) as u64;
    let mut probes: Vec<(f64, u64)> = Vec::new();
    let mut next_probe = 0.0f64;
    let start = Instant::now();
    let mut misses = 0u64;

    for n in 0..total_out_frames {
        let t = n as f64 / out_fps as f64;
        if paced {
            let target = start.elapsed().as_secs_f64();
            if t > target {
                tokio::time::sleep(Duration::from_secs_f64(t - target)).await;
            }
        }
        let frame = streaming.get_frame(t as f32).await;
        match frame {
            Some(f) => {
                if t >= next_probe {
                    probes.push((t, fnv(f.data())));
                    next_probe += probe_every_secs;
                    eprintln!(
                        "probe t={t:.2}s hash={:016x} wall={:.1}s misses={misses}",
                        probes.last().unwrap().1,
                        start.elapsed().as_secs_f64()
                    );
                }
            }
            None => {
                misses += 1;
                if t >= next_probe {
                    probes.push((t, 0));
                    next_probe += probe_every_secs;
                    eprintln!("probe t={t:.2}s MISS (decode timeout)");
                }
            }
        }
    }
    eprintln!(
        "streaming pass done in {:.1}s, misses={misses}",
        start.elapsed().as_secs_f64()
    );

    if noref {
        return;
    }

    // Reference pass: fresh decoder, cold-seek to each probe time.
    let reference =
        cap_rendering::decoder::spawn_decoder("probe-ref", path.clone(), fps, 0.0, force_ffmpeg)
            .await
            .expect("spawn reference decoder");

    let mut mismatches = 0;
    for (t, stream_hash) in &probes {
        let ref_frame = reference.get_frame(*t as f32).await;
        let ref_hash = ref_frame.map(|f| fnv(f.data())).unwrap_or(0);
        let ok = ref_hash == *stream_hash;
        if !ok {
            mismatches += 1;
            let mut found: Option<f64> = None;
            for i in 1..=(10.0 * fps as f64) as i64 {
                for sign in [-1i64, 1] {
                    let dt = sign as f64 * i as f64 / fps as f64;
                    let tt = t + dt;
                    if tt < 0.0 || tt > duration {
                        continue;
                    }
                    if let Some(f) = reference.get_frame(tt as f32).await
                        && fnv(f.data()) == *stream_hash
                    {
                        found = Some(dt);
                        break;
                    }
                }
                if found.is_some() {
                    break;
                }
            }
            println!(
                "MISMATCH t={t:.2}s stream={stream_hash:016x} ref={ref_hash:016x} stream_content_offset={:?}",
                found
            );
        } else {
            println!("ok t={t:.2}s");
        }
    }
    println!("total probes={}, mismatches={mismatches}", probes.len());
}
