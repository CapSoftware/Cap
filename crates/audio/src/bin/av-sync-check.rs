//! Measures audio/video sync offset and drift from a flash+beep "clapperboard"
//! recording produced with `scripts/av-sync/av-sync-stimulus.html`.
//!
//! It detects each white-flash frame in the video (luminance spike) and each
//! click onset in the audio (energy spike), pairs them, and reports the per-event
//! offset plus a linear drift fit. The drift slope is the authoritative metric:
//! a constant offset is dominated by stimulus/display/output latency, but a
//! non-zero slope means the recording pipeline is losing sync over time.
//!
//! Usage:
//!   av-sync-check --video <file> [--audio <file>] [--csv <out.csv>]
//!                 [--flash-frac 0.5] [--click-frac 0.3] [--interval 2.0]
//!
//! `--audio` defaults to `--video` (works for an instant-mode output.mp4 whose
//! audio is muxed in). For a studio recording, pass the display/camera mp4 as
//! `--video` and the `audio-input`/`system_audio` track as `--audio`.

use std::path::{Path, PathBuf};

use cap_audio::AudioData;

struct Args {
    video: PathBuf,
    audio: PathBuf,
    csv: Option<PathBuf>,
    flash_frac: f64,
    click_frac: f64,
    interval: f64,
}

fn parse_args() -> Result<Args, String> {
    let mut video: Option<PathBuf> = None;
    let mut audio: Option<PathBuf> = None;
    let mut csv: Option<PathBuf> = None;
    let mut flash_frac = 0.35;
    let mut click_frac = 0.3;
    let mut interval = 2.0;

    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        let mut take = |name: &str| -> Result<String, String> {
            args.next()
                .ok_or_else(|| format!("{name} requires a value"))
        };
        match arg.as_str() {
            "--video" => video = Some(take("--video")?.into()),
            "--audio" => audio = Some(take("--audio")?.into()),
            "--csv" => csv = Some(take("--csv")?.into()),
            "--flash-frac" => {
                flash_frac = take("--flash-frac")?.parse().map_err(|e| format!("{e}"))?
            }
            "--click-frac" => {
                click_frac = take("--click-frac")?.parse().map_err(|e| format!("{e}"))?
            }
            "--interval" => interval = take("--interval")?.parse().map_err(|e| format!("{e}"))?,
            "-h" | "--help" => return Err("help".to_string()),
            other if video.is_none() => video = Some(other.into()),
            other => return Err(format!("unexpected argument: {other}")),
        }
    }

    let video = video.ok_or("missing --video <file>")?;
    let audio = audio.unwrap_or_else(|| video.clone());

    Ok(Args {
        video,
        audio,
        csv,
        flash_frac,
        click_frac,
        interval,
    })
}

fn drain_video_frames(
    decoder: &mut ffmpeg::decoder::Video,
    scaler: &mut ffmpeg::software::scaling::context::Context,
    time_base: f64,
    series: &mut Vec<(f64, f64)>,
) -> Result<(), String> {
    let mut decoded = ffmpeg::frame::Video::empty();
    let mut gray = ffmpeg::frame::Video::empty();

    while decoder.receive_frame(&mut decoded).is_ok() {
        scaler
            .run(&decoded, &mut gray)
            .map_err(|e| format!("scale frame: {e}"))?;

        let ts = decoded.timestamp().or_else(|| decoded.pts()).unwrap_or(0);
        let time_secs = ts as f64 * time_base;

        let width = gray.width() as usize;
        let height = gray.height() as usize;
        let stride = gray.stride(0);
        let data = gray.data(0);

        let mut sum: u64 = 0;
        for row in data.chunks(stride).take(height) {
            sum += row[..width].iter().map(|&b| u64::from(b)).sum::<u64>();
        }
        let pixels = (width * height).max(1) as f64;
        series.push((time_secs, sum as f64 / pixels));
    }

    Ok(())
}

/// Per-frame mean luminance over the whole recording: `(time_secs, luma 0..255)`.
fn video_luma_series(path: &Path) -> Result<Vec<(f64, f64)>, String> {
    let mut input = ffmpeg::format::input(&path).map_err(|e| format!("open video: {e}"))?;
    let stream = input
        .streams()
        .best(ffmpeg::media::Type::Video)
        .ok_or("no video stream")?;
    let stream_index = stream.index();
    let tb = stream.time_base();
    let time_base = f64::from(tb.numerator()) / f64::from(tb.denominator()).max(1.0);

    let ctx = ffmpeg::codec::Context::from_parameters(stream.parameters())
        .map_err(|e| format!("video params: {e}"))?;
    let mut decoder = ctx
        .decoder()
        .video()
        .map_err(|e| format!("video decoder: {e}"))?;
    decoder.set_packet_time_base(tb);

    let mut scaler = ffmpeg::software::scaling::context::Context::get(
        decoder.format(),
        decoder.width(),
        decoder.height(),
        ffmpeg::format::Pixel::GRAY8,
        decoder.width(),
        decoder.height(),
        ffmpeg::software::scaling::flag::Flags::BILINEAR,
    )
    .map_err(|e| format!("create scaler: {e}"))?;

    let mut series = Vec::new();
    for (stream, packet) in input.packets() {
        if stream.index() != stream_index {
            continue;
        }
        decoder
            .send_packet(&packet)
            .map_err(|e| format!("send packet: {e}"))?;
        drain_video_frames(&mut decoder, &mut scaler, time_base, &mut series)?;
    }
    decoder.send_eof().map_err(|e| format!("send eof: {e}"))?;
    drain_video_frames(&mut decoder, &mut scaler, time_base, &mut series)?;

    Ok(series)
}

/// Windowed RMS of the audio (mono-summed), one point per `hop` samples.
fn audio_energy_series(path: &Path, hop: usize) -> Result<Vec<(f64, f64)>, String> {
    let data = AudioData::from_file(path)?;
    let channels = data.channels().max(1) as usize;
    let samples = data.samples();
    let frame_count = samples.len() / channels;
    let rate = AudioData::SAMPLE_RATE as f64;

    let mut series = Vec::new();
    let mut start = 0;
    while start < frame_count {
        let end = (start + hop).min(frame_count);
        let mut energy = 0.0f64;
        for frame in start..end {
            let base = frame * channels;
            let mono =
                f64::from(samples[base..base + channels].iter().sum::<f32>()) / channels as f64;
            energy += mono * mono;
        }
        let count = (end - start).max(1) as f64;
        series.push((start as f64 / rate, (energy / count).sqrt()));
        start += hop;
    }

    Ok(series)
}

/// Rising-edge onset times. The threshold is relative to a *local* trailing
/// baseline (min over the last ~0.4s) rather than the global min, so a varying
/// background — desktop frames before/after the stimulus, letterbox bars, room
/// noise floor — does not swallow real events. `frac` of the robust p5..p95
/// range sets the spike margin above that baseline; events are debounced.
fn detect_onsets(series: &[(f64, f64)], frac: f64, debounce: f64) -> Vec<f64> {
    if series.len() < 8 {
        return Vec::new();
    }

    let mut sorted: Vec<f64> = series.iter().map(|p| p.1).collect();
    sorted.sort_by(f64::total_cmp);
    // Floor from a low percentile (robust to a few dark/quiet outliers); peak from
    // the max, because flashes/clicks are sparse spikes — a high percentile would
    // still sit in the background and collapse the range to zero.
    let floor = sorted[sorted.len() / 10];
    let peak = *sorted.last().unwrap_or(&floor);
    let range = peak - floor;
    if !range.is_finite() || range <= f64::EPSILON {
        return Vec::new();
    }
    let margin = frac * range;

    let dt = series[1].0 - series[0].0;
    let window = if dt > 0.0 {
        ((0.4 / dt).round() as usize).max(1)
    } else {
        1
    };

    let mut onsets = Vec::new();
    let mut armed = true;
    let mut last = f64::NEG_INFINITY;
    for (i, &(time, v)) in series.iter().enumerate() {
        let lo = i.saturating_sub(window);
        let baseline = series[lo..=i]
            .iter()
            .map(|p| p.1)
            .fold(f64::INFINITY, f64::min);
        let high = baseline + margin;
        let rearm = baseline + 0.35 * margin;

        if armed && v >= high && (time - last) >= debounce {
            onsets.push(time);
            last = time;
            armed = false;
        } else if v <= rearm {
            armed = true;
        }
    }
    onsets
}

/// Keeps only pairs whose offset is within `tol` of the median offset. The true
/// A/V offset is near-constant, so a pair that disagrees by more than `tol` is a
/// missed/false detection (a flash paired to the wrong click), not real drift.
fn reject_offset_outliers(pairs: &[(f64, f64)], tol: f64) -> Vec<(f64, f64)> {
    if pairs.len() < 3 {
        return pairs.to_vec();
    }
    let mut offsets: Vec<f64> = pairs.iter().map(|p| p.1).collect();
    offsets.sort_by(f64::total_cmp);
    let median = offsets[offsets.len() / 2];
    pairs
        .iter()
        .copied()
        .filter(|&(_, o)| (o - median).abs() <= tol)
        .collect()
}

/// For each flash, the nearest click within `max_dist`: `(flash_time, offset)`,
/// where `offset = flash_time - click_time` (positive = video lags audio).
fn pair_events(flashes: &[f64], clicks: &[f64], max_dist: f64) -> Vec<(f64, f64)> {
    let mut pairs = Vec::new();
    for &flash in flashes {
        let nearest = clicks
            .iter()
            .min_by(|a, b| (**a - flash).abs().total_cmp(&(**b - flash).abs()));
        if let Some(&click) = nearest
            && (flash - click).abs() <= max_dist
        {
            pairs.push((flash, flash - click));
        }
    }
    pairs
}

/// Least-squares fit of `y` on `x`: `(slope, intercept, r_squared)`.
fn linear_fit(points: &[(f64, f64)]) -> (f64, f64, f64) {
    let n = points.len() as f64;
    if n < 2.0 {
        return (0.0, points.first().map(|p| p.1).unwrap_or(0.0), 0.0);
    }
    let mean_x = points.iter().map(|p| p.0).sum::<f64>() / n;
    let mean_y = points.iter().map(|p| p.1).sum::<f64>() / n;
    let mut sxx = 0.0;
    let mut sxy = 0.0;
    let mut syy = 0.0;
    for &(x, y) in points {
        let dx = x - mean_x;
        let dy = y - mean_y;
        sxx += dx * dx;
        sxy += dx * dy;
        syy += dy * dy;
    }
    let slope = if sxx > 0.0 { sxy / sxx } else { 0.0 };
    let intercept = mean_y - slope * mean_x;
    let r2 = if sxx > 0.0 && syy > 0.0 {
        (sxy * sxy) / (sxx * syy)
    } else {
        0.0
    };
    (slope, intercept, r2)
}

fn report(
    args: &Args,
    pairs: &[(f64, f64)],
    flash_count: usize,
    click_count: usize,
    rejected: usize,
) {
    println!("flashes detected: {flash_count}");
    println!("clicks detected:  {click_count}");
    println!("matched pairs:    {}", pairs.len());
    if rejected > 0 {
        println!(
            "outliers dropped: {rejected} (events >200ms off the median — missed/false detections)"
        );
    }

    if pairs.len() < 2 {
        println!(
            "\nNot enough matched events to measure drift. Check that the recording shows the \
             stimulus full-screen with audible clicks, and tune --flash-frac / --click-frac."
        );
        return;
    }

    let offsets_ms: Vec<f64> = pairs.iter().map(|p| p.1 * 1000.0).collect();
    let mean = offsets_ms.iter().sum::<f64>() / offsets_ms.len() as f64;
    let max_abs = offsets_ms.iter().fold(0.0f64, |m, &o| m.max(o.abs()));
    let variance =
        offsets_ms.iter().map(|o| (o - mean).powi(2)).sum::<f64>() / offsets_ms.len() as f64;
    let std = variance.sqrt();

    let (slope, intercept, r2) = linear_fit(pairs);
    let drift_ms_per_min = slope * 60_000.0;
    let span_secs =
        pairs.last().map(|p| p.0).unwrap_or(0.0) - pairs.first().map(|p| p.0).unwrap_or(0.0);

    println!("\n--- offset (video - audio), positive = video lags audio ---");
    println!("mean offset:      {mean:+.1} ms");
    println!("offset stddev:    {std:.1} ms");
    println!("max |offset|:     {max_abs:.1} ms");
    println!("\n--- drift (the authoritative metric) ---");
    println!(
        "recording span:   {span_secs:.1} s across {} events",
        pairs.len()
    );
    println!("drift slope:      {drift_ms_per_min:+.2} ms/min   (r²={r2:.3})");
    println!("offset @ t=0:     {:+.1} ms", intercept * 1000.0);

    // A slope is only a real trend if it explains most of the offset variance.
    // A low r² means the "slope" is just a line fit through per-event jitter
    // (capture-frame quantisation), not progressive desync — the injected-drift
    // validation case sits at r²≈1.0, a clean recording at r²≈0.2.
    let trend_is_real = r2 >= 0.5 && pairs.len() >= 5;
    let drift_verdict = if !trend_is_real {
        "no significant trend — offset is stable; drift below the jitter floor"
    } else if drift_ms_per_min.abs() < 10.0 {
        "EXCELLENT — no meaningful drift"
    } else if drift_ms_per_min.abs() < 30.0 {
        "OK — minor drift, imperceptible on short recordings"
    } else {
        "INVESTIGATE — sustained drift exceeds 30 ms/min"
    };
    let consistency_verdict = if std < 15.0 {
        "tight"
    } else if std < 40.0 {
        "acceptable"
    } else {
        "noisy — detection may be misfiring; tune thresholds"
    };
    println!("\nDRIFT:       {drift_verdict}");
    println!("CONSISTENCY: {consistency_verdict} (stddev {std:.1} ms)");

    let expected = if args.interval > 0.0 {
        Some((span_secs / args.interval).round() as usize + 1)
    } else {
        None
    };
    if let Some(expected) = expected
        && pairs.len() + 2 < expected
    {
        println!(
            "\nNOTE: matched {} events but expected ~{} at {:.1}s spacing — some flashes/clicks \
             were missed; treat the numbers as approximate.",
            pairs.len(),
            expected,
            args.interval
        );
    }
    println!(
        "\nReminder: the constant offset includes stimulus + display + audio-output latency. \
         Compare the DRIFT slope across device combinations — it should stay near zero everywhere."
    );
}

fn write_csv(path: &Path, pairs: &[(f64, f64)]) -> Result<(), String> {
    use std::fmt::Write as _;
    let mut out = String::from("flash_time_secs,offset_ms\n");
    for &(time, offset) in pairs {
        let _ = writeln!(out, "{time:.4},{:.3}", offset * 1000.0);
    }
    std::fs::write(path, out).map_err(|e| format!("write csv: {e}"))
}

fn run() -> Result<(), String> {
    let args = parse_args()?;
    ffmpeg::init().map_err(|e| format!("ffmpeg init: {e}"))?;

    println!("video: {}", args.video.display());
    println!("audio: {}", args.audio.display());

    let luma = video_luma_series(&args.video)?;
    let energy = audio_energy_series(&args.audio, 96)?;

    let flashes = detect_onsets(&luma, args.flash_frac, 0.5);
    let clicks = detect_onsets(&energy, args.click_frac, 0.5);

    let raw_pairs = pair_events(&flashes, &clicks, args.interval * 0.5);
    let pairs = reject_offset_outliers(&raw_pairs, 0.2);
    let rejected = raw_pairs.len() - pairs.len();

    report(&args, &pairs, flashes.len(), clicks.len(), rejected);

    if let Some(csv) = &args.csv {
        write_csv(csv, &pairs)?;
        println!("\nwrote per-event offsets to {}", csv.display());
    }

    Ok(())
}

fn main() {
    if let Err(e) = run() {
        if e == "help" {
            eprintln!(
                "av-sync-check --video <file> [--audio <file>] [--csv <out.csv>]\n\
                 \x20             [--flash-frac 0.5] [--click-frac 0.3] [--interval 2.0]\n\n\
                 Measures A/V offset and drift from an av-sync-stimulus recording."
            );
            std::process::exit(2);
        }
        eprintln!("error: {e}");
        std::process::exit(1);
    }
}
