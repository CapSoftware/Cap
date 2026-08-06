//! Real-endpoint validation of the WASAPI loopback capture path.
//!
//! The synthetic sync matrix proves the pipeline math, but the Windows
//! loopback behaviors this exercises only exist against a real audio
//! endpoint: the silent-render keepalive (packets must flow while the
//! system plays nothing), AUDCLNT_BUFFERFLAGS_SILENT zeroing (engine
//! silence must decode as digital zeros, not stale buffer contents), and
//! GetBuffer QPC capture timestamps.
//!
//! On developer machines without a usable render endpoint the test skips
//! loudly. CI installs a virtual audio device (Scream) and sets
//! `CAP_REQUIRE_AUDIO_ENDPOINT=1`, which turns both the missing-endpoint
//! skip and the content assertions into hard failures — silence on CI is
//! digital, so any nonzero sample there is a real defect.
#![cfg(windows)]

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use cap_timestamp::{Timestamp, Timestamps};

#[derive(Debug, Clone, Copy)]
struct PacketEvent {
    arrived_at: Instant,
    /// Capture timestamp (GetBuffer qpc_position) relative to the test epoch.
    capture_secs: f64,
    rms: f64,
    /// None when the device mix format is something we don't inspect.
    content_known: bool,
}

fn rms_of(data: &cpal::Data) -> Option<f64> {
    match data.sample_format() {
        cpal::SampleFormat::F32 => {
            let s = data.as_slice::<f32>()?;
            if s.is_empty() {
                return Some(0.0);
            }
            Some(
                (s.iter().map(|&v| f64::from(v) * f64::from(v)).sum::<f64>() / s.len() as f64)
                    .sqrt(),
            )
        }
        cpal::SampleFormat::I16 => {
            let s = data.as_slice::<i16>()?;
            if s.is_empty() {
                return Some(0.0);
            }
            Some(
                (s.iter()
                    .map(|&v| {
                        let f = f64::from(v) / f64::from(i16::MAX);
                        f * f
                    })
                    .sum::<f64>()
                    / s.len() as f64)
                    .sqrt(),
            )
        }
        _ => None,
    }
}

/// Plays a 440 Hz tone on the default render device until dropped.
fn play_tone() -> Option<cpal::Stream> {
    use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};

    let host = cpal::default_host();
    let device = host.default_output_device()?;
    let supported = device.default_output_config().ok()?;
    let channels = supported.channels() as usize;
    let rate = supported.sample_rate().0 as f32;
    let config: cpal::StreamConfig = supported.clone().into();

    let mut n: u64 = 0;
    let stream = match supported.sample_format() {
        cpal::SampleFormat::F32 => device
            .build_output_stream(
                &config,
                move |data: &mut [f32], _| {
                    for frame in data.chunks_mut(channels) {
                        let v = (n as f32 * 440.0 * 2.0 * std::f32::consts::PI / rate).sin() * 0.5;
                        frame.fill(v);
                        n += 1;
                    }
                },
                |_| {},
                None,
            )
            .ok()?,
        cpal::SampleFormat::I16 => device
            .build_output_stream(
                &config,
                move |data: &mut [i16], _| {
                    for frame in data.chunks_mut(channels) {
                        let v = (n as f32 * 440.0 * 2.0 * std::f32::consts::PI / rate).sin() * 0.5;
                        frame.fill((v * f32::from(i16::MAX)) as i16);
                        n += 1;
                    }
                },
                |_| {},
                None,
            )
            .ok()?,
        _ => return None,
    };
    stream.play().ok()?;
    Some(stream)
}

#[test]
fn loopback_delivers_through_silence_and_captures_tone() {
    let require_endpoint = std::env::var("CAP_REQUIRE_AUDIO_ENDPOINT").is_ok();

    let reference = Timestamps::now();
    let events: Arc<Mutex<Vec<PacketEvent>>> = Arc::new(Mutex::new(Vec::new()));

    let capturer = {
        let events = events.clone();
        scap_cpal::create_capturer(
            move |data, info, _config| {
                let capture_secs = Timestamp::from_cpal(info.timestamp().capture)
                    .signed_duration_since_secs(reference);
                let rms = rms_of(data);
                events.lock().unwrap().push(PacketEvent {
                    arrived_at: Instant::now(),
                    capture_secs,
                    rms: rms.unwrap_or(0.0),
                    content_known: rms.is_some(),
                });
            },
            |e| eprintln!("loopback stream error: {e}"),
        )
    };

    let capturer = match capturer {
        Ok(c) => c,
        Err(e) => {
            assert!(
                !require_endpoint,
                "CAP_REQUIRE_AUDIO_ENDPOINT is set but the loopback capturer \
                 could not be created: {e}. On CI this means the virtual audio \
                 driver did not install correctly."
            );
            eprintln!("skipping: no usable render endpoint ({e})");
            return;
        }
    };

    assert!(
        capturer.has_silence_keepalive(),
        "the silent-render keepalive must be active; without it loopback \
         only produces packets while other applications play audio"
    );

    capturer.play().expect("loopback stream failed to start");

    // Phase 1: nothing plays. The keepalive alone must keep packets flowing,
    // and with an idle engine every sample must be digital zero (the SILENT
    // buffer-flag path).
    let phase1 = Duration::from_secs(3);
    std::thread::sleep(phase1);
    let silence_events: Vec<PacketEvent> = events.lock().unwrap().drain(..).collect();

    let packets = silence_events.len();
    assert!(
        packets >= 10,
        "only {packets} loopback packets arrived during {phase1:?} of system \
         silence; the silent-render keepalive is not keeping the endpoint hot"
    );

    // Capture timestamps must track real time (QPC-derived, not garbage).
    let first = silence_events.first().unwrap();
    let last = silence_events.last().unwrap();
    let capture_span = last.capture_secs - first.capture_secs;
    let wall_span = last
        .arrived_at
        .duration_since(first.arrived_at)
        .as_secs_f64();
    assert!(
        (capture_span - wall_span).abs() < 0.5,
        "loopback capture timestamps advanced {capture_span:.3}s while wall \
         time advanced {wall_span:.3}s"
    );
    assert!(
        first.capture_secs > -1.0 && first.capture_secs < 5.0,
        "first capture timestamp {:.3}s is not near the test epoch",
        first.capture_secs
    );

    if require_endpoint {
        // CI: the runner plays nothing, so silence is digital. Any nonzero
        // sample means unspecified SILENT-flagged buffer contents leaked
        // through as audio.
        let loudest = silence_events
            .iter()
            .filter(|e| e.content_known)
            .map(|e| e.rms)
            .fold(0.0f64, f64::max);
        assert!(
            loudest == 0.0,
            "captured rms {loudest} during engine silence; SILENT-flagged \
             packets are not being zeroed"
        );
    }

    // Phase 2: play a tone into the endpoint; the loopback must capture it.
    let Some(tone) = play_tone() else {
        assert!(
            !require_endpoint,
            "CAP_REQUIRE_AUDIO_ENDPOINT is set but no tone could be played \
             on the default render device"
        );
        eprintln!("skipping tone phase: could not open an output stream");
        return;
    };
    std::thread::sleep(Duration::from_millis(1500));
    drop(tone);
    std::thread::sleep(Duration::from_millis(200));
    let tone_events: Vec<PacketEvent> = events.lock().unwrap().drain(..).collect();

    let heard = tone_events
        .iter()
        .filter(|e| e.content_known)
        .map(|e| e.rms)
        .fold(0.0f64, f64::max);
    assert!(
        heard > 0.05,
        "loopback captured no audible content while a 440 Hz tone played \
         (max rms {heard}); real render output is not reaching the capture path"
    );

    capturer.pause().ok();
}
