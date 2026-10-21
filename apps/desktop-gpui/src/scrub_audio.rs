//! Audio scrubbing: while the playhead is dragged, the editor asks for a
//! short slice of the mix under it and this plays it on a small output
//! stream of its own, so it never disturbs the playback pipeline.

use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::Duration;

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use tracing::warn;

/// Length of each scrub slice; the next one replaces whatever is left.
pub const SNIPPET_SECS: f64 = 0.09;
/// The output stream is paused after this long without a slice.
const IDLE_PAUSE: Duration = Duration::from_secs(2);

/// Interleaved stereo waiting to be played, and the read position in frames.
#[derive(Default)]
struct ScrubBuffer {
    samples: Vec<f32>,
    position: f64,
}

static PLAYER: LazyLock<Mutex<Option<Sender<Vec<f32>>>>> = LazyLock::new(Default::default);

/// Plays one scrub slice (interleaved stereo at
/// [`cap_editor::AudioRenderer::SAMPLE_RATE`]), replacing whatever is left of
/// the previous one.
pub fn play(samples: Vec<f32>) {
    if samples.is_empty() {
        return;
    }
    let mut player = PLAYER.lock().unwrap_or_else(|p| p.into_inner());
    if let Some(tx) = player.as_ref()
        && tx.send(samples.clone()).is_ok()
    {
        return;
    }
    match spawn_player() {
        Ok(tx) => {
            let _ = tx.send(samples);
            *player = Some(tx);
        }
        Err(error) => warn!("Scrub audio unavailable: {error}"),
    }
}

/// Starts the thread that owns the output stream (cpal streams are not Send).
fn spawn_player() -> Result<Sender<Vec<f32>>, String> {
    let (tx, rx) = mpsc::channel::<Vec<f32>>();
    let (ready_tx, ready_rx) = mpsc::channel::<Result<(), String>>();
    std::thread::Builder::new()
        .name("scrub-audio".into())
        .spawn(move || {
            let queue = Arc::new(Mutex::new(ScrubBuffer::default()));
            let stream = match build_stream(queue.clone()) {
                Ok(stream) => {
                    let _ = ready_tx.send(Ok(()));
                    stream
                }
                Err(error) => {
                    let _ = ready_tx.send(Err(error));
                    return;
                }
            };
            let mut playing = false;
            loop {
                match rx.recv_timeout(IDLE_PAUSE) {
                    Ok(slice) => {
                        *queue.lock().unwrap_or_else(|p| p.into_inner()) = ScrubBuffer {
                            samples: slice,
                            position: 0.0,
                        };
                        if !playing {
                            playing = stream.play().is_ok();
                        }
                    }
                    Err(RecvTimeoutError::Timeout) => {
                        if playing {
                            let _ = stream.pause();
                            playing = false;
                        }
                    }
                    Err(RecvTimeoutError::Disconnected) => break,
                }
            }
        })
        .map_err(|e| e.to_string())?;
    ready_rx
        .recv_timeout(Duration::from_secs(2))
        .map_err(|e| e.to_string())??;
    Ok(tx)
}

/// Builds an f32 output stream fed from `queue`, which holds interleaved
/// stereo at the renderer's sample rate; it is resampled (nearest frame) and
/// mapped to the device's channel count on the way out.
fn build_stream(queue: Arc<Mutex<ScrubBuffer>>) -> Result<cpal::Stream, String> {
    let device = cpal::default_host()
        .default_output_device()
        .ok_or("No audio output device")?;
    let supported = device.default_output_config().map_err(|e| e.to_string())?;
    if supported.sample_format() != cpal::SampleFormat::F32 {
        return Err(format!(
            "Unsupported scrub output format {:?}",
            supported.sample_format()
        ));
    }
    let config = supported.config();
    let out_channels = usize::from(config.channels);
    let step = f64::from(cap_editor::AudioRenderer::SAMPLE_RATE) / f64::from(config.sample_rate.0);

    let stream = device
        .build_output_stream(
            &config,
            move |buffer: &mut [f32], _| {
                let mut queue = queue.lock().unwrap_or_else(|p| p.into_inner());
                let ScrubBuffer { samples, position } = &mut *queue;
                for frame in buffer.chunks_mut(out_channels) {
                    let index = *position as usize * 2;
                    let (Some(&left), Some(&right)) = (samples.get(index), samples.get(index + 1))
                    else {
                        frame.fill(0.0);
                        continue;
                    };
                    for (channel, sample) in frame.iter_mut().enumerate() {
                        *sample = match channel {
                            0 => left,
                            1 => right,
                            _ => 0.0,
                        };
                    }
                    if out_channels == 1 {
                        frame[0] = (left + right) * 0.5;
                    }
                    *position += step;
                }
            },
            |error| warn!("Scrub audio stream error: {error}"),
            None,
        )
        .map_err(|e| e.to_string())?;
    Ok(stream)
}
