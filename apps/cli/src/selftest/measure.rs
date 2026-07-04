//! Content-level A/V sync measurement for the self-test.
//!
//! Extracts flash onsets from a video track (mean luma over the frame
//! center with adaptive hysteresis) and beep onsets from an audio track
//! (RMS envelope with an adaptive threshold), pairs them, and computes
//! robust offset and drift statistics. Positive offset means audio is late.

use std::path::Path;

use ffmpeg::{codec, format, frame, media};
use serde::Serialize;

/// Fraction of the frame (centered) used for luma measurement, avoiding
/// menu bars, notches and window chrome at the edges.
const CENTER_CROP: f64 = 0.5;
/// Minimum spacing between onsets, guarding against double-triggers within
/// a single tone burst.
const MIN_ONSET_GAP_SECS: f64 = 0.5;

pub fn video_flash_onsets(path: &Path) -> Result<Vec<f64>, String> {
    let mut ictx =
        format::input(&path).map_err(|e| format!("open video {}: {e}", path.display()))?;
    let stream = ictx
        .streams()
        .best(media::Type::Video)
        .ok_or("no video stream")?;
    let stream_index = stream.index();
    let time_base = stream.time_base();
    let tb = f64::from(time_base.numerator()) / f64::from(time_base.denominator());

    let ctx = codec::context::Context::from_parameters(stream.parameters())
        .map_err(|e| format!("video codec params: {e}"))?;
    let mut decoder = ctx
        .decoder()
        .video()
        .map_err(|e| format!("video decoder: {e}"))?;

    let mut samples: Vec<(f64, f64)> = Vec::new();
    let mut take_frame = |decoded: &frame::Video| {
        let Some(pts) = decoded.pts() else { return };
        let t = pts as f64 * tb;
        if let Some(luma) = mean_center_luma(decoded) {
            samples.push((t, luma));
        }
    };

    let mut decoded = frame::Video::empty();
    for (s, packet) in ictx.packets() {
        if s.index() != stream_index {
            continue;
        }
        if decoder.send_packet(&packet).is_ok() {
            while decoder.receive_frame(&mut decoded).is_ok() {
                take_frame(&decoded);
            }
        }
    }
    let _ = decoder.send_eof();
    while decoder.receive_frame(&mut decoded).is_ok() {
        take_frame(&decoded);
    }

    flash_onsets_from_luma(&samples)
}

/// Flash onsets from a time-ordered `(seconds, mean luma)` series, shared by
/// the file analyzers and the playback harness (which samples luma at the
/// renderer's presentation boundary).
pub fn flash_onsets_from_luma(samples: &[(f64, f64)]) -> Result<Vec<f64>, String> {
    if samples.len() < 10 {
        return Err(format!(
            "only {} video frames decoded; recording too short to analyze",
            samples.len()
        ));
    }

    // Adaptive hysteresis from the observed luma range so exact black/white
    // levels (color range, HDR tone mapping) don't matter. The high anchor is
    // the peak, not a percentile: flashes are a small duty cycle of frames.
    let mut lumas: Vec<f64> = samples.iter().map(|(_, l)| *l).collect();
    lumas.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let lo = percentile_sorted(&lumas, 0.10);
    let hi = percentile_sorted(&lumas, 0.998);
    if hi - lo < 40.0 {
        return Err(format!(
            "test pattern not visible in the recording (luma range {lo:.0}..{hi:.0}); \
             the test window may have been covered or moved"
        ));
    }
    let on = lo + 0.7 * (hi - lo);
    let off = lo + 0.3 * (hi - lo);

    let mut onsets = Vec::new();
    let mut armed = true;
    for (t, luma) in samples {
        if *luma >= on && armed {
            onsets.push(*t);
            armed = false;
        } else if *luma <= off {
            armed = true;
        }
    }
    Ok(onsets)
}

fn mean_center_luma(frame: &frame::Video) -> Option<f64> {
    // Plane 0 is luma for all YUV formats the decoders produce. Reject
    // non-planar/packed formats rather than misreading them.
    use ffmpeg::format::Pixel;
    if !matches!(
        frame.format(),
        Pixel::YUV420P | Pixel::NV12 | Pixel::YUV422P | Pixel::YUV444P | Pixel::YUVJ420P
    ) {
        return None;
    }
    let width = frame.width() as usize;
    let height = frame.height() as usize;
    let stride = frame.stride(0);
    let data = frame.data(0);

    let x0 = (width as f64 * (0.5 - CENTER_CROP / 2.0)) as usize;
    let x1 = (width as f64 * (0.5 + CENTER_CROP / 2.0)) as usize;
    let y0 = (height as f64 * (0.5 - CENTER_CROP / 2.0)) as usize;
    let y1 = (height as f64 * (0.5 + CENTER_CROP / 2.0)) as usize;

    let mut sum = 0u64;
    let mut count = 0u64;
    let mut y = y0;
    while y < y1.min(height) {
        let row = &data[y * stride..y * stride + width];
        let mut x = x0;
        while x < x1.min(width) {
            sum += u64::from(row[x]);
            count += 1;
            x += 4;
        }
        y += 4;
    }
    (count > 0).then(|| sum as f64 / count as f64)
}

pub struct AudioOnsets {
    pub onsets: Vec<f64>,
    /// Ratio of tone peak to noise floor; low values mean the beep was not
    /// reliably captured (e.g. muted output).
    pub snr: f64,
}

pub fn audio_beep_onsets(path: &Path) -> Result<AudioOnsets, String> {
    let mut ictx =
        format::input(&path).map_err(|e| format!("open audio {}: {e}", path.display()))?;
    let stream = ictx
        .streams()
        .best(media::Type::Audio)
        .ok_or("no audio stream")?;
    let stream_index = stream.index();

    let ctx = codec::context::Context::from_parameters(stream.parameters())
        .map_err(|e| format!("audio codec params: {e}"))?;
    let mut decoder = ctx
        .decoder()
        .audio()
        .map_err(|e| format!("audio decoder: {e}"))?;

    let mut mono: Vec<f32> = Vec::new();
    let mut sample_rate = 0u32;
    let mut take_frame = |decoded: &frame::Audio| {
        sample_rate = decoded.rate();
        append_mono(decoded, &mut mono);
    };

    let mut decoded = frame::Audio::empty();
    for (s, packet) in ictx.packets() {
        if s.index() != stream_index {
            continue;
        }
        if decoder.send_packet(&packet).is_ok() {
            while decoder.receive_frame(&mut decoded).is_ok() {
                take_frame(&decoded);
            }
        }
    }
    let _ = decoder.send_eof();
    while decoder.receive_frame(&mut decoded).is_ok() {
        take_frame(&decoded);
    }

    beep_onsets_from_mono(mono, sample_rate)
}

/// Beep onsets from a mono sample stream, shared by the file analyzers and
/// the playback harness (which taps samples at the device handoff).
pub fn beep_onsets_from_mono(mut mono: Vec<f32>, sample_rate: u32) -> Result<AudioOnsets, String> {
    if sample_rate == 0 || mono.len() < sample_rate as usize {
        return Err("audio track too short to analyze".to_string());
    }

    bandpass_1khz_in_place(&mut mono, sample_rate);

    // 1 ms RMS envelope.
    let chunk = (sample_rate / 1000).max(1) as usize;
    let mut env: Vec<f32> = mono
        .chunks(chunk)
        .map(|c| (c.iter().map(|s| s * s).sum::<f32>() / c.len() as f32).sqrt())
        .collect();
    let chunk_secs = chunk as f64 / f64::from(sample_rate);

    let mut sorted = env.clone();
    sorted.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let noise_floor = f64::from(percentile_sorted_f32(&sorted, 0.20)).max(1e-6);
    let peak = f64::from(percentile_sorted_f32(&sorted, 0.999));
    let snr = peak / noise_floor;
    // Edge-triggered hysteresis: after bandpassing, the tone bursts dominate
    // the envelope peak while background audio (music, speech) sits well
    // below it. A rising edge through the high threshold marks an onset; the
    // detector re-arms only after the envelope falls back through the low
    // threshold, so sustained background level cannot mask or spam onsets.
    let hi = ((noise_floor * 8.0).max(peak * 0.35)) as f32;
    let lo = hi * 0.5;

    let mut onsets = Vec::new();
    let mut armed = true;
    let mut last = f64::NEG_INFINITY;
    for (i, value) in env.drain(..).enumerate() {
        let t = i as f64 * chunk_secs;
        if value >= hi && armed && t - last >= MIN_ONSET_GAP_SECS {
            onsets.push(t);
            last = t;
            armed = false;
        } else if value < lo {
            armed = true;
        }
    }

    Ok(AudioOnsets { onsets, snr })
}

/// Second-order (RBJ) bandpass centered on the 1 kHz test tone. Real
/// machines play music/speech during a self-test; narrowband filtering lets
/// the constant-frequency beep dominate the envelope regardless.
fn bandpass_1khz_in_place(samples: &mut [f32], sample_rate: u32) {
    let f0 = 1000.0f64;
    let q = 8.0f64;
    let w0 = 2.0 * std::f64::consts::PI * f0 / f64::from(sample_rate.max(2001));
    let alpha = w0.sin() / (2.0 * q);
    let cos_w0 = w0.cos();
    let a0 = 1.0 + alpha;
    let b0 = (alpha / a0) as f32;
    let b2 = (-alpha / a0) as f32;
    let a1 = (-2.0 * cos_w0 / a0) as f32;
    let a2 = ((1.0 - alpha) / a0) as f32;

    let (mut x1, mut x2, mut y1, mut y2) = (0.0f32, 0.0f32, 0.0f32, 0.0f32);
    for sample in samples.iter_mut() {
        let x0 = *sample;
        let y0 = b0 * x0 + b2 * x2 - a1 * y1 - a2 * y2;
        x2 = x1;
        x1 = x0;
        y2 = y1;
        y1 = y0;
        *sample = y0;
    }
}

fn append_mono(decoded: &frame::Audio, out: &mut Vec<f32>) {
    use ffmpeg::format::Sample;
    use ffmpeg::format::sample::Type;
    let samples = decoded.samples();
    let channels = decoded.channels() as usize;
    if samples == 0 || channels == 0 {
        return;
    }
    match decoded.format() {
        Sample::F32(Type::Planar) => {
            let planes: Vec<&[f32]> = (0..channels.min(decoded.planes()))
                .map(|p| &decoded.plane::<f32>(p)[..samples])
                .collect();
            for i in 0..samples {
                let sum: f32 = planes.iter().map(|p| p[i]).sum();
                out.push(sum / planes.len() as f32);
            }
        }
        Sample::F32(Type::Packed) => {
            let data = &decoded.plane::<f32>(0)[..samples * channels];
            for frame in data.chunks_exact(channels) {
                out.push(frame.iter().sum::<f32>() / channels as f32);
            }
        }
        Sample::I16(Type::Planar) => {
            let planes: Vec<&[i16]> = (0..channels.min(decoded.planes()))
                .map(|p| &decoded.plane::<i16>(p)[..samples])
                .collect();
            for i in 0..samples {
                let sum: f32 = planes.iter().map(|p| f32::from(p[i])).sum();
                out.push(sum / (planes.len() as f32 * f32::from(i16::MAX)));
            }
        }
        Sample::I16(Type::Packed) => {
            let data = &decoded.plane::<i16>(0)[..samples * channels];
            for frame in data.chunks_exact(channels) {
                let sum: f32 = frame.iter().map(|s| f32::from(*s)).sum();
                out.push(sum / (channels as f32 * f32::from(i16::MAX)));
            }
        }
        _ => {
            // Unknown format; skip frame rather than misread it.
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct SyncMeasurement {
    pub paired_events: usize,
    pub inlier_events: usize,
    pub median_offset_ms: f64,
    pub mad_ms: f64,
    pub drift_ms_per_min: f64,
    /// Drift accumulated across the observed window (slope × span). More
    /// robust to slope noise on short runs than the per-minute rate.
    pub total_drift_ms: f64,
    pub span_secs: f64,
    pub min_offset_ms: f64,
    pub max_offset_ms: f64,
    /// (flash time, offset ms) per inlier event.
    pub events: Vec<(f64, f64)>,
}

/// Pairs flash onsets with the nearest beep onset (both on the same clock)
/// and computes robust statistics. The first event after settle is dropped:
/// window creation/compositor transitions make it unrepresentative.
pub fn measure_sync(
    flash_onsets: &[f64],
    beep_onsets: &[f64],
    min_events: usize,
) -> Result<SyncMeasurement, String> {
    if flash_onsets.len() < 2 {
        return Err(format!(
            "only {} flash events detected in the recording",
            flash_onsets.len()
        ));
    }
    if beep_onsets.is_empty() {
        return Err("no beeps detected in the recording".to_string());
    }

    let mut pairs: Vec<(f64, f64)> = Vec::new();
    for flash in flash_onsets {
        let Some(beep) = beep_onsets
            .iter()
            .min_by(|a, b| {
                (*a - flash)
                    .abs()
                    .partial_cmp(&(*b - flash).abs())
                    .unwrap_or(std::cmp::Ordering::Equal)
            })
            .copied()
        else {
            continue;
        };
        let offset = beep - flash;
        if offset.abs() <= 0.9 {
            pairs.push((*flash, offset * 1000.0));
        }
    }
    // Drop the first event: window-creation transitions make it noisy.
    if pairs.len() > min_events {
        pairs.remove(0);
    }
    if pairs.len() < min_events {
        return Err(format!(
            "only {} usable flash/beep pairs (need {min_events}; detected {} flashes, {} beeps); \
             the test window may have been covered or the beeps too quiet",
            pairs.len(),
            flash_onsets.len(),
            beep_onsets.len()
        ));
    }

    // Anchor on the densest offset cluster: mispaired events (a flash
    // matching the wrong beep because the true one was masked) land seconds
    // away, and with enough of them the median itself becomes junk. The true
    // pairs all share one physical offset, so they form the tightest cluster.
    let cluster_center = {
        let mut best_center = 0.0;
        let mut best_count = 0usize;
        for (_, candidate) in &pairs {
            let count = pairs
                .iter()
                .filter(|(_, o)| (o - candidate).abs() <= 60.0)
                .count();
            if count > best_count {
                best_count = count;
                best_center = *candidate;
            }
        }
        best_center
    };

    let mut inliers: Vec<(f64, f64)> = pairs
        .iter()
        .filter(|(_, o)| (o - cluster_center).abs() <= 90.0)
        .copied()
        .collect();
    if inliers.len() < min_events {
        // No dominant cluster: report statistics over every pair and let the
        // caller's thresholds judge them, rather than discarding the run.
        inliers = pairs.clone();
    }

    let mut offsets: Vec<f64> = inliers.iter().map(|(_, o)| *o).collect();
    offsets.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let median = percentile_sorted(&offsets, 0.5);
    let mut deviations: Vec<f64> = offsets.iter().map(|o| (o - median).abs()).collect();
    deviations.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let mad = percentile_sorted(&deviations, 0.5);

    // Least-squares slope of offset over time = drift.
    let n = inliers.len() as f64;
    let mean_t = inliers.iter().map(|(t, _)| t).sum::<f64>() / n;
    let mean_o = inliers.iter().map(|(_, o)| o).sum::<f64>() / n;
    let mut num = 0.0;
    let mut den = 0.0;
    for (t, o) in &inliers {
        num += (t - mean_t) * (o - mean_o);
        den += (t - mean_t) * (t - mean_t);
    }
    let slope_ms_per_sec = if den > 0.0 { num / den } else { 0.0 };

    let min = inliers
        .iter()
        .map(|(_, o)| *o)
        .fold(f64::INFINITY, f64::min);
    let max = inliers
        .iter()
        .map(|(_, o)| *o)
        .fold(f64::NEG_INFINITY, f64::max);
    let span_secs = inliers.last().map(|(t, _)| *t).unwrap_or(0.0)
        - inliers.first().map(|(t, _)| *t).unwrap_or(0.0);

    Ok(SyncMeasurement {
        paired_events: pairs.len(),
        inlier_events: inliers.len(),
        median_offset_ms: median,
        mad_ms: mad,
        drift_ms_per_min: slope_ms_per_sec * 60.0,
        total_drift_ms: slope_ms_per_sec * span_secs,
        span_secs,
        min_offset_ms: min,
        max_offset_ms: max,
        events: inliers,
    })
}

fn percentile_sorted(sorted: &[f64], q: f64) -> f64 {
    if sorted.is_empty() {
        return 0.0;
    }
    let idx = ((sorted.len() - 1) as f64 * q).round() as usize;
    sorted[idx.min(sorted.len() - 1)]
}

fn percentile_sorted_f32(sorted: &[f32], q: f64) -> f32 {
    if sorted.is_empty() {
        return 0.0;
    }
    let idx = ((sorted.len() - 1) as f64 * q).round() as usize;
    sorted[idx.min(sorted.len() - 1)]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn measure_sync_detects_constant_offset() {
        let flashes: Vec<f64> = (1..12).map(|k| k as f64 * 2.0).collect();
        let beeps: Vec<f64> = flashes.iter().map(|f| f + 0.030).collect();
        let m = measure_sync(&flashes, &beeps, 6).unwrap();
        assert!((m.median_offset_ms - 30.0).abs() < 1.0);
        assert!(m.total_drift_ms.abs() < 1.0);
    }

    #[test]
    fn measure_sync_detects_drift() {
        // 5 ms/s of drift = 300 ms/min.
        let flashes: Vec<f64> = (1..12).map(|k| k as f64 * 2.0).collect();
        let beeps: Vec<f64> = flashes.iter().map(|f| f + 0.005 * f).collect();
        let m = measure_sync(&flashes, &beeps, 6).unwrap();
        assert!(
            (m.drift_ms_per_min - 300.0).abs() < 30.0,
            "drift {}",
            m.drift_ms_per_min
        );
        assert!(m.total_drift_ms > 50.0, "total {}", m.total_drift_ms);
    }

    #[test]
    fn measure_sync_rejects_outliers() {
        let mut flashes: Vec<f64> = (1..12).map(|k| k as f64 * 2.0).collect();
        let beeps: Vec<f64> = flashes.iter().map(|f| f + 0.020).collect();
        // A wild first event, like a window-transition artifact.
        flashes[0] -= 0.6;
        let m = measure_sync(&flashes, &beeps, 6).unwrap();
        assert!((m.median_offset_ms - 20.0).abs() < 2.0);
        assert!(m.inlier_events >= 9);
    }

    #[test]
    fn measure_sync_scattered_offsets_still_report_stats() {
        // Half the events displaced by 60ms: no clean inlier set exists, but
        // the caller still needs numbers (large MAD) to fail on, not an error.
        let flashes: Vec<f64> = (1..12).map(|k| k as f64 * 2.0).collect();
        let beeps: Vec<f64> = flashes
            .iter()
            .enumerate()
            .map(|(i, f)| f + if i % 2 == 0 { 0.010 } else { 0.070 })
            .collect();
        let m = measure_sync(&flashes, &beeps, 6).unwrap();
        assert!(m.mad_ms >= 20.0, "mad {}", m.mad_ms);
    }

    #[test]
    fn measure_sync_fails_with_too_few_events() {
        let flashes = vec![2.0, 4.0];
        let beeps = vec![2.02, 4.02];
        assert!(measure_sync(&flashes, &beeps, 6).is_err());
    }
}
