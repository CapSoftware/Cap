use std::path::PathBuf;
use std::time::{Duration, Instant};

use cap_sensitive_scan::synthetic::{Canvas, PROSE, sans, view_rect};
use cap_sensitive_scan::{
    LumaFrame, Rect, ScanSettings, Scanner, SensitiveKind, TextReader, detect, in_motion,
    mask_rect_at, mask_segments,
};

const WIDTH: u32 = 1920;
const HEIGHT: u32 = 1080;
const VIDEO_FPS: f64 = 30.0;
const ACCURACY_EVERY: usize = 30;

struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 = self
            .0
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        self.0 >> 33
    }

    fn pick<'a>(&mut self, items: &[&'a str]) -> &'a str {
        items[self.next() as usize % items.len()]
    }

    fn chars(&mut self, alphabet: &str, len: usize) -> String {
        let alphabet: Vec<char> = alphabet.chars().collect();
        (0..len)
            .map(|_| alphabet[self.next() as usize % alphabet.len()])
            .collect()
    }
}

const BASE62: &str = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

fn card(rng: &mut Rng) -> String {
    let mut digits: Vec<u32> = vec![4];
    digits.extend((0..14).map(|_| (rng.next() % 10) as u32));
    let sum: u32 = digits
        .iter()
        .rev()
        .enumerate()
        .map(|(i, d)| {
            if i % 2 == 0 {
                let x = d * 2;
                if x > 9 { x - 9 } else { x }
            } else {
                *d
            }
        })
        .sum();
    digits.push((10 - sum % 10) % 10);
    digits
        .chunks(4)
        .map(|chunk| {
            chunk
                .iter()
                .map(|d| char::from_digit(*d, 10).unwrap())
                .collect::<String>()
        })
        .collect::<Vec<_>>()
        .join(" ")
}

fn secret(rng: &mut Rng, index: usize) -> (String, String, SensitiveKind) {
    let first = rng.pick(&["jane", "omar", "li", "priya", "tom", "ana", "kofi", "sven"]);
    let last = rng.pick(&[
        "doe", "haddad", "wei", "shah", "baker", "silva", "mensah", "berg",
    ]);
    let domain = rng.pick(&[
        "acme-corp.com",
        "example.org",
        "northwind.io",
        "contoso.co.uk",
    ]);
    match index % 9 {
        0 => (
            "Billing contact".into(),
            format!("{first}.{last}@{domain}"),
            SensitiveKind::Email,
        ),
        1 => (
            "Support line".into(),
            format!(
                "+44 20 {} {}",
                rng.chars("0123456789", 4),
                rng.chars("0123456789", 4)
            ),
            SensitiveKind::Phone,
        ),
        2 => ("Card on file".into(), card(rng), SensitiveKind::CardNumber),
        3 => (
            "Stripe secret".into(),
            format!("sk_live_{}", rng.chars(BASE62, 24)),
            SensitiveKind::Secret,
        ),
        4 => (
            "GitHub token".into(),
            format!("ghp_{}", rng.chars(BASE62, 36)),
            SensitiveKind::Secret,
        ),
        5 => (
            "AWS access key".into(),
            format!("AKIA{}", rng.chars("ABCDEFGHIJKLMNOPQRSTUVWXYZ234567", 16)),
            SensitiveKind::Secret,
        ),
        6 => (
            "DATABASE_PASSWORD=".into(),
            rng.chars(BASE62, 14),
            SensitiveKind::Secret,
        ),
        7 => (
            "Mobile".into(),
            format!("(415) 555-{}", rng.chars("0123456789", 4)),
            SensitiveKind::Phone,
        ),
        _ => (
            "Client".into(),
            "Acme Robotics".into(),
            SensitiveKind::CustomPhrase,
        ),
    }
}

fn decoy(rng: &mut Rng, index: usize) -> (String, String) {
    match index % 8 {
        0 => (
            "Version".into(),
            format!(
                "v{}.{}.{}",
                rng.next() % 9,
                rng.next() % 30,
                rng.next() % 99
            ),
        ),
        1 => ("Commit".into(), rng.chars("0123456789abcdef", 40)),
        2 => (
            "Updated".into(),
            format!(
                "2026-{:02}-{:02} 10:{:02}",
                rng.next() % 12 + 1,
                rng.next() % 28 + 1,
                rng.next() % 60
            ),
        ),
        3 => (
            "Host".into(),
            format!(
                "10.{}.{}.{}",
                rng.next() % 255,
                rng.next() % 255,
                rng.next() % 255
            ),
        ),
        4 => (
            "Request id".into(),
            format!(
                "{}-{}-{}-{}-{}",
                rng.chars("0123456789abcdef", 8),
                rng.chars("0123456789abcdef", 4),
                rng.chars("0123456789abcdef", 4),
                rng.chars("0123456789abcdef", 4),
                rng.chars("0123456789abcdef", 12)
            ),
        ),
        5 => ("Order".into(), format!("#{}", rng.chars("0123456789", 9))),
        6 => (
            "Build".into(),
            format!(
                "{}.{}.{}",
                2026,
                rng.next() % 12 + 1,
                rng.chars("0123456789", 4)
            ),
        ),
        _ => ("Path".into(), "/var/lib/cap/recordings/demo.cap".into()),
    }
}

struct Scenario {
    name: &'static str,
    background: u8,
    ink: u8,
    size: f32,
    zoom: fn(f64) -> f32,
    scroll: fn(f64) -> f32,
}

fn page(scenario: &Scenario, seed: u64) -> (Canvas, Vec<(Rect, SensitiveKind)>, Vec<Rect>) {
    let font = sans();
    let mut rng = Rng(seed);
    let mut canvas = Canvas::new(WIDTH, 6200, scenario.background);
    let mut secrets = Vec::new();
    let mut decoys = Vec::new();
    let line_height = (scenario.size * 2.0).round();
    let mut y = 40.0;
    let mut row = 0usize;
    while y < 6100.0 {
        let column = 120.0 + (row % 2) as f32 * 760.0;
        match row % 4 {
            0 => {
                let (label, value, kind) = secret(&mut rng, row / 4);
                let label_rect = canvas.text(&font, scenario.size, column, y, &label, scenario.ink);
                let rect = canvas.text(
                    &font,
                    scenario.size,
                    label_rect.x1 + scenario.size,
                    y,
                    &value,
                    scenario.ink,
                );
                secrets.push((rect, kind));
            }
            1 => {
                let (label, value) = decoy(&mut rng, row / 4);
                let label_rect = canvas.text(&font, scenario.size, column, y, &label, scenario.ink);
                let rect = canvas.text(
                    &font,
                    scenario.size,
                    label_rect.x1 + scenario.size,
                    y,
                    &value,
                    scenario.ink,
                );
                decoys.push(rect);
            }
            _ => {
                let text = PROSE[(rng.next() as usize) % PROSE.len()];
                canvas.text(&font, scenario.size, 120.0, y, text, scenario.ink);
            }
        }
        y += line_height;
        row += 1;
    }
    (canvas, secrets, decoys)
}

fn smooth_scroll(t: f64) -> f32 {
    let phase = t % 6.0;
    let base = (t / 6.0).floor() as f32 * 900.0;
    base + if phase < 1.5 {
        0.0
    } else {
        ((phase - 1.5) / 4.5).min(1.0) as f32 * 900.0
    }
}

fn wheel_scroll(t: f64) -> f32 {
    ((t / 0.25).floor() as f32 * 120.0) % 4800.0
}

fn fast_flick(t: f64) -> f32 {
    let phase = t % 2.5;
    let base = ((t / 2.5).floor() as f32 * 1100.0) % 4400.0;
    let throw = (phase / 0.4).min(1.0);
    base + (1.0 - (1.0 - throw).powi(3)) as f32 * 1100.0
}

fn still(_: f64) -> f32 {
    1200.0
}

fn no_zoom(_: f64) -> f32 {
    1.0
}

fn zoom_in_out(t: f64) -> f32 {
    let phase = t % 6.0;
    let ease = |x: f64| (x * x * (3.0 - 2.0 * x)) as f32;
    if phase < 1.0 {
        1.0
    } else if phase < 2.0 {
        1.0 + 0.6 * ease(phase - 1.0)
    } else if phase < 4.0 {
        1.6
    } else if phase < 5.0 {
        1.6 - 0.6 * ease(phase - 4.0)
    } else {
        1.0
    }
}

struct Totals {
    seconds: f64,
    scan: Duration,
    ocr_frames: usize,
    truth_visible: usize,
    truth_found: usize,
    detections: usize,
    detections_true: usize,
    secret_frames: usize,
    leaked_frames: usize,
    masks: usize,
    false_masks: usize,
}

fn covered_fraction(target: Rect, masks: &[Rect]) -> f32 {
    let mut total = 0;
    let mut covered = 0;
    let mut y = target.y0 + 0.5;
    while y < target.y1 {
        let mut x = target.x0 + 0.5;
        while x < target.x1 {
            total += 1;
            if masks
                .iter()
                .any(|m| x >= m.x0 && x <= m.x1 && y >= m.y0 && y <= m.y1)
            {
                covered += 1;
            }
            x += 1.0;
        }
        y += 1.0;
    }
    if total == 0 {
        1.0
    } else {
        covered as f32 / total as f32
    }
}

fn run(
    reader: &TextReader,
    scenario: &Scenario,
    seconds: f64,
    settings: &ScanSettings,
    totals: &mut Totals,
) -> anyhow::Result<()> {
    let (canvas, secrets, _) = page(scenario, 7);
    let frame_at = |t: f64| {
        canvas.view(
            0.0,
            (scenario.scroll)(t),
            WIDTH,
            HEIGHT,
            (scenario.zoom)(t),
            scenario.background,
        )
    };
    let truth_at = |t: f64| -> Vec<Rect> {
        secrets
            .iter()
            .map(|(rect, _)| {
                view_rect(
                    *rect,
                    0.0,
                    (scenario.scroll)(t),
                    WIDTH,
                    HEIGHT,
                    (scenario.zoom)(t),
                )
            })
            .collect()
    };
    let screen = Rect::new(0.0, 0.0, WIDTH as f32, HEIGHT as f32);

    let mut scanner = Scanner::new(reader, settings.clone());
    let mut scan_time = Duration::ZERO;
    let mut previous: Option<(f64, LumaFrame)> = None;
    for (index, time) in settings.sample_times(seconds).into_iter().enumerate() {
        let frame: LumaFrame = frame_at(time);
        let started = Instant::now();
        if let Some((before, earlier)) = &previous
            && in_motion(earlier, &frame)
        {
            let middle = (before + time) / 2.0;
            scanner.push_frame(middle, &frame_at(middle))?;
        }
        scanner.push_frame(time, &frame)?;
        scan_time += started.elapsed();
        if index % ACCURACY_EVERY == ACCURACY_EVERY / 2 {
            let found = detect(&reader.read(&frame)?, &settings.phrases);
            let visible: Vec<Rect> = truth_at(time)
                .into_iter()
                .filter(|rect| rect.intersection(&screen).area() >= rect.area() * 0.999)
                .collect();
            totals.truth_visible += visible.len();
            totals.truth_found += visible
                .iter()
                .filter(|truth| {
                    found
                        .iter()
                        .any(|d| d.rect.intersection(truth).area() >= truth.area() * 0.5)
                })
                .count();
            totals.detections += found.len();
            totals.detections_true += found
                .iter()
                .filter(|d| {
                    truth_at(time)
                        .iter()
                        .any(|truth| d.rect.intersection(truth).area() >= d.rect.area() * 0.3)
                })
                .count();
        }
        previous = Some((time, frame));
    }
    let ocr_frames = scanner.ocr_frames() + 1;
    let started = Instant::now();
    let tracks = scanner.finish()?;
    let masks = mask_segments(&tracks, &[], seconds);
    scan_time += started.elapsed();
    totals.scan += scan_time;
    totals.seconds += seconds;
    totals.masks += masks.len();
    totals.ocr_frames += ocr_frames;
    totals.false_masks += masks
        .iter()
        .filter(|mask| {
            let mid = (mask.start + mask.end) / 2.0;
            let Some(rect) = mask_rect_at(mask, mid) else {
                return true;
            };
            let rect = rect.scaled(WIDTH as f32, HEIGHT as f32);
            !truth_at(mid)
                .iter()
                .any(|truth| truth.intersection(&rect).area() > 0.0)
        })
        .count();

    let mut leaks = 0;
    let mut secret_frames = 0;
    let frames = (seconds * VIDEO_FPS) as usize;
    for frame in 0..frames {
        let time = frame as f64 / VIDEO_FPS;
        let active: Vec<Rect> = masks
            .iter()
            .filter_map(|mask| mask_rect_at(mask, time))
            .map(|rect| rect.scaled(WIDTH as f32, HEIGHT as f32))
            .collect();
        let visible: Vec<Rect> = truth_at(time)
            .into_iter()
            .map(|rect| rect.expanded(-1.0, -1.0).intersection(&screen))
            .filter(|rect| rect.area() > 4.0)
            .collect();
        if visible.is_empty() {
            continue;
        }
        secret_frames += 1;
        if visible
            .iter()
            .any(|truth| covered_fraction(*truth, &active) < 0.98)
        {
            leaks += 1;
        }
    }
    totals.leaked_frames += leaks;
    totals.secret_frames += secret_frames;
    println!(
        "{:<16} {:>5.1}s video  {:>6.2}s scan  {:>4} masks  {:>4} leaked of {:>4} frames with secrets",
        scenario.name,
        seconds,
        scan_time.as_secs_f64(),
        masks.len(),
        leaks,
        secret_frames,
    );
    Ok(())
}

fn main() -> anyhow::Result<()> {
    let mut args = std::env::args().skip(1);
    let models =
        PathBuf::from(args.next().ok_or_else(|| {
            anyhow::anyhow!("usage: scan-bench <models dir> [seconds per scenario]")
        })?);
    let seconds: f64 = args.next().map(|s| s.parse()).transpose()?.unwrap_or(20.0);
    let reader = TextReader::load(&models)?;
    let settings = ScanSettings {
        phrases: vec!["Acme Robotics".into()],
        ..Default::default()
    };
    let scenarios = [
        Scenario {
            name: "light, smooth",
            background: 248,
            ink: 30,
            size: 16.0,
            zoom: no_zoom,
            scroll: smooth_scroll,
        },
        Scenario {
            name: "dark, wheel",
            background: 28,
            ink: 225,
            size: 15.0,
            zoom: no_zoom,
            scroll: wheel_scroll,
        },
        Scenario {
            name: "light, fast flick",
            background: 248,
            ink: 30,
            size: 16.0,
            zoom: no_zoom,
            scroll: fast_flick,
        },
        Scenario {
            name: "light, zoom",
            background: 248,
            ink: 30,
            size: 14.0,
            zoom: zoom_in_out,
            scroll: still,
        },
    ];
    let mut totals = Totals {
        seconds: 0.0,
        scan: Duration::ZERO,
        ocr_frames: 0,
        truth_visible: 0,
        truth_found: 0,
        detections: 0,
        detections_true: 0,
        secret_frames: 0,
        leaked_frames: 0,
        masks: 0,
        false_masks: 0,
    };
    for scenario in &scenarios {
        run(&reader, scenario, seconds, &settings, &mut totals)?;
    }
    let pct = |a: usize, b: usize| {
        if b == 0 {
            100.0
        } else {
            a as f64 * 100.0 / b as f64
        }
    };
    println!();
    println!(
        "frames read by OCR          {} ({:.1} per minute)",
        totals.ocr_frames,
        totals.ocr_frames as f64 * 60.0 / totals.seconds
    );
    println!(
        "detection recall            {:.1}% ({} of {} fully visible secrets)",
        pct(totals.truth_found, totals.truth_visible),
        totals.truth_found,
        totals.truth_visible
    );
    println!(
        "detection precision         {:.1}% ({} of {} detections)",
        pct(totals.detections_true, totals.detections),
        totals.detections_true,
        totals.detections
    );
    println!(
        "frames with a secret leaked {:.2}% ({} of {} frames at {VIDEO_FPS} fps)",
        pct(totals.leaked_frames, totals.secret_frames),
        totals.leaked_frames,
        totals.secret_frames
    );
    println!(
        "masks on no secret          {} of {}",
        totals.false_masks, totals.masks
    );
    println!(
        "scan speed                  {:.1}s per minute of 1080p ({:.1}s for {:.0}s, {} threads)",
        totals.scan.as_secs_f64() * 60.0 / totals.seconds,
        totals.scan.as_secs_f64(),
        totals.seconds,
        std::thread::available_parallelism().map_or(1, |n| n.get()),
    );
    Ok(())
}
