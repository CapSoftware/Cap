use std::f32::consts::TAU;

const RATE: u32 = 44_100;
const LENGTH_SECS: f32 = 0.9;
const GAIN: f32 = 0.16;

struct Note {
    at: f32,
    hz: f32,
    level: f32,
}

const NOTES: [Note; 2] = [
    Note {
        at: 0.0,
        hz: 987.77,
        level: 1.0,
    },
    Note {
        at: 0.11,
        hz: 1318.51,
        level: 0.8,
    },
];

pub fn samples() -> Vec<f32> {
    let count = (RATE as f32 * LENGTH_SECS) as usize;
    let mut out = vec![0.0f32; count];
    for note in &NOTES {
        let start = (note.at * RATE as f32) as usize;
        for (offset, sample) in out.iter_mut().skip(start).enumerate() {
            let t = offset as f32 / RATE as f32;
            let attack = (t / 0.004).min(1.0);
            let body = (-t / 0.16).exp();
            let shimmer = (-t / 0.05).exp();
            let tone = (TAU * note.hz * t).sin() + 0.18 * (TAU * note.hz * 2.0 * t).sin() * shimmer;
            *sample += tone * attack * body * note.level;
        }
    }
    let peak = out
        .iter()
        .fold(0.0f32, |peak, sample| peak.max(sample.abs()));
    let scale = if peak > 0.0 { GAIN / peak } else { 0.0 };
    let tail = (RATE as f32 * 0.03) as usize;
    let len = out.len();
    for (index, sample) in out.iter_mut().enumerate() {
        let fade = if index + tail >= len {
            (len - index) as f32 / tail as f32
        } else {
            1.0
        };
        *sample *= scale * fade;
    }
    out
}

pub fn play() {
    if let Err(error) = std::thread::Builder::new()
        .name("meeting-chime".into())
        .spawn(|| {
            if let Err(error) = play_to_end() {
                tracing::warn!(%error, "meeting chime unavailable");
            }
        })
    {
        tracing::warn!(%error, "could not start the meeting chime");
    }
}

fn play_to_end() -> anyhow::Result<()> {
    use anyhow::Context as _;
    let (_stream, handle) = crate::app_sounds::open_output().context("opening audio output")?;
    let sink = rodio::Sink::try_new(&handle).context("creating chime sink")?;
    sink.append(rodio::buffer::SamplesBuffer::new(1, RATE, samples()));
    sink.sleep_until_end();
    Ok(())
}
