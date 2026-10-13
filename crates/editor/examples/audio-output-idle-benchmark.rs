use std::{
    sync::Arc,
    time::{Duration, Instant},
};

use cap_audio::{AudioData, DecodedAudio};
use cap_editor::{
    AudioOutput, MusicTracks, PlaySpec, SegmentAudioTimingRepair, audio_segment_from_decoded,
};
use cap_project::ProjectConfiguration;
use tokio::sync::watch;

const CLIP_SECS: f64 = 4.0;
const AUDIBLE_SECS: f64 = 0.3;

fn usage() -> ! {
    eprintln!(
        "usage:\n  audio-output-idle-benchmark idle <secs>\n  audio-output-idle-benchmark latency <reps> <warm_gap_secs> <idle_gap_secs>\n  audio-output-idle-benchmark cycles <count> <idle_gap_secs>\n  audio-output-idle-benchmark presses <secs,secs,...>"
    );
    std::process::exit(2);
}

fn count_arg(args: &[String], index: usize) -> usize {
    args.get(index)
        .and_then(|v| v.parse::<usize>().ok())
        .filter(|count| *count > 0)
        .unwrap_or_else(|| usage())
}

fn secs(value: &str) -> Option<Duration> {
    value
        .trim()
        .parse::<f64>()
        .ok()
        .and_then(|secs| Duration::try_from_secs_f64(secs).ok())
}

fn secs_arg(args: &[String], index: usize) -> Duration {
    args.get(index)
        .and_then(|v| secs(v))
        .unwrap_or_else(|| usage())
}

fn quiet_tone() -> Arc<AudioData> {
    let sample_rate = AudioData::SAMPLE_RATE as f64;
    let frames = (CLIP_SECS * sample_rate) as usize;
    let mut samples = Vec::with_capacity(frames * 2);
    for frame in 0..frames {
        let value =
            (std::f64::consts::TAU * 440.0 * frame as f64 / sample_rate).sin() as f32 * 0.02;
        samples.push(value);
        samples.push(value);
    }
    Arc::new(AudioData::from_raw_f32(samples, 2))
}

fn spec(tone: &Arc<AudioData>) -> PlaySpec {
    let project = ProjectConfiguration::default();
    let (_, playhead_rx) = watch::channel(0.0);
    PlaySpec {
        segments: vec![audio_segment_from_decoded(
            None,
            Some(Arc::new(DecodedAudio::from(tone.clone()))),
            SegmentAudioTimingRepair::default(),
        )],
        music: MusicTracks::new(),
        project,
        duration_secs: CLIP_SECS,
        start_playhead_secs: 0.0,
        playhead_rx,
    }
}

fn press(output: &AudioOutput, tone: &Arc<AudioData>) -> f64 {
    let spec = spec(tone);
    let started = Instant::now();
    let generation = output.play(spec);
    let elapsed_ms = started.elapsed().as_secs_f64() * 1000.0;
    let Some(generation) = generation else {
        eprintln!("play returned no audio");
        std::process::exit(1);
    };
    std::thread::sleep(Duration::from_secs_f64(AUDIBLE_SECS));
    output.stop_playback(generation);
    elapsed_ms
}

fn median(values: &mut [f64]) -> f64 {
    values.sort_by(f64::total_cmp);
    values[values.len() / 2]
}

fn main() {
    tracing_subscriber::fmt()
        .with_writer(std::io::stderr)
        .with_target(false)
        .init();
    let _ = ffmpeg::init();
    let args: Vec<String> = std::env::args().collect();
    match args.get(1).map(String::as_str) {
        Some("idle") => {
            let duration = secs_arg(&args, 2);
            let output = AudioOutput::new();
            output.prewarm();
            std::thread::sleep(duration);
            drop(output);
        }
        Some("latency") => {
            let reps = count_arg(&args, 2);
            let warm_gap = secs_arg(&args, 3);
            let idle_gap = secs_arg(&args, 4);
            let tone = quiet_tone();
            let mut cold = Vec::new();
            let mut prewarmed = Vec::new();
            let mut warm = Vec::new();
            let mut after_idle = Vec::new();
            for rep in 0..reps {
                {
                    let output = AudioOutput::new();
                    cold.push(press(&output, &tone));
                }
                std::thread::sleep(Duration::from_millis(500));
                let output = AudioOutput::new();
                output.prewarm();
                std::thread::sleep(Duration::from_secs(1));
                prewarmed.push(press(&output, &tone));
                std::thread::sleep(warm_gap);
                warm.push(press(&output, &tone));
                std::thread::sleep(idle_gap);
                after_idle.push(press(&output, &tone));
                println!(
                    "rep {rep}: cold {:.2} ms, prewarmed {:.2} ms, warm {:.2} ms, after_idle {:.2} ms",
                    cold[rep], prewarmed[rep], warm[rep], after_idle[rep]
                );
            }
            for (name, values) in [
                ("cold", &mut cold),
                ("prewarmed", &mut prewarmed),
                ("warm", &mut warm),
                ("after_idle", &mut after_idle),
            ] {
                let min = values.iter().copied().fold(f64::INFINITY, f64::min);
                let max = values.iter().copied().fold(0.0, f64::max);
                println!(
                    "{name}: median {:.2} ms (min {min:.2}, max {max:.2}, n {})",
                    median(values),
                    values.len()
                );
            }
        }
        Some("cycles") => {
            let cycles = count_arg(&args, 2);
            let idle_gap = secs_arg(&args, 3);
            let tone = quiet_tone();
            let output = AudioOutput::new();
            output.prewarm();
            let mut direct = Vec::new();
            let mut hinted = Vec::new();
            for cycle in 0..cycles {
                std::thread::sleep(idle_gap);
                if cycle % 2 == 0 {
                    direct.push(press(&output, &tone));
                } else {
                    output.prewarm();
                    std::thread::sleep(Duration::from_millis(100));
                    hinted.push(press(&output, &tone));
                }
            }
            for (name, values) in [
                ("after_idle", &mut direct),
                ("after_idle_prewarm_100ms", &mut hinted),
            ] {
                if values.is_empty() {
                    continue;
                }
                let min = values.iter().copied().fold(f64::INFINITY, f64::min);
                let max = values.iter().copied().fold(0.0, f64::max);
                println!(
                    "{name}: median {:.2} ms (min {min:.2}, max {max:.2}, n {})",
                    median(values),
                    values.len()
                );
            }
        }
        Some("presses") => {
            let times: Vec<Duration> = args
                .get(2)
                .and_then(|list| list.split(',').map(secs).collect())
                .unwrap_or_else(|| usage());
            let tone = quiet_tone();
            let started = Instant::now();
            let output = AudioOutput::new();
            output.prewarm();
            for at in times {
                let wait = at.saturating_sub(started.elapsed());
                std::thread::sleep(wait);
                let ms = press(&output, &tone);
                println!(
                    "t={:.1}s press: audio consumed after {ms:.2} ms",
                    started.elapsed().as_secs_f64()
                );
            }
        }
        _ => usage(),
    }
}
