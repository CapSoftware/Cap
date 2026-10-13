//! Compares X11 frame grabs via MIT-SHM (`ShmGetImage`) and plain `GetImage`,
//! including the copy into the FFmpeg frame.
//!
//!   xvfb-run -s "-screen 0 3840x2160x24" \
//!     cargo run --release -p cap-recording --example x11-capture-benchmark [-- --json]

#[cfg(not(target_os = "linux"))]
fn main() {
    eprintln!("x11-capture-benchmark: skipped (not Linux)");
}

#[cfg(target_os = "linux")]
fn main() -> anyhow::Result<()> {
    linux::run()
}

#[cfg(target_os = "linux")]
mod linux {
    use anyhow::{Context as _, bail};
    use cap_recording::screen_capture::{X11Grabber, X11InputConfig};
    use clap::Parser;
    use serde::Serialize;
    use std::time::Instant;
    use x11rb::connection::Connection as _;

    const DISABLE_SHM_ENV: &str = "CAP_X11_DISABLE_SHM";

    #[derive(Parser)]
    struct Args {
        #[arg(long, default_value_t = 30)]
        warmup: usize,
        #[arg(long, default_value_t = 300)]
        iterations: usize,
        #[arg(long)]
        json: bool,
    }

    #[derive(Serialize)]
    struct Stats {
        backend: &'static str,
        mean_ms: f64,
        p50_ms: f64,
        p95_ms: f64,
        p99_ms: f64,
        mpix_per_s: f64,
    }

    #[derive(Serialize)]
    struct SizeResult {
        label: &'static str,
        width: u32,
        height: u32,
        get_image: Stats,
        shm: Stats,
        speedup: f64,
    }

    const SIZES: [(&str, u32, u32); 4] = [
        ("720p", 1280, 720),
        ("1080p", 1920, 1080),
        ("1440p", 2560, 1440),
        ("4K", 3840, 2160),
    ];

    pub fn run() -> anyhow::Result<()> {
        let args = Args::parse();
        let display = std::env::var("DISPLAY").context("DISPLAY is not set")?;
        let (conn, screen) = x11rb::connect(Some(&display))?;
        let root = &conn.setup().roots[screen];
        let (screen_width, screen_height) = (
            u32::from(root.width_in_pixels),
            u32::from(root.height_in_pixels),
        );
        drop(conn);

        let mut results = Vec::new();
        for (label, width, height) in SIZES {
            if width > screen_width || height > screen_height {
                eprintln!("skipping {label}: screen is {screen_width}x{screen_height}");
                continue;
            }
            let config = X11InputConfig {
                display_name: display.clone(),
                window_id: None,
                x: 0,
                y: 0,
                width,
                height,
                fps: 60,
                show_cursor: false,
            };
            let get_image = measure(&config, false, &args)?;
            let shm = measure(&config, true, &args)?;
            results.push(SizeResult {
                label,
                width,
                height,
                speedup: get_image.mean_ms / shm.mean_ms,
                get_image,
                shm,
            });
        }

        if args.json {
            println!("{}", serde_json::to_string_pretty(&results)?);
            return Ok(());
        }

        println!(
            "X11 capture benchmark on {display} ({screen_width}x{screen_height}), {} warmup + {} iterations\n",
            args.warmup, args.iterations
        );
        println!("| size | backend | mean ms | p50 ms | p95 ms | p99 ms | Mpix/s | speedup |");
        println!("|---|---|---|---|---|---|---|---|");
        for result in &results {
            for (stats, speedup) in [
                (&result.get_image, String::new()),
                (&result.shm, format!("{:.2}x", result.speedup)),
            ] {
                println!(
                    "| {} ({}x{}) | {} | {:.3} | {:.3} | {:.3} | {:.3} | {:.0} | {} |",
                    result.label,
                    result.width,
                    result.height,
                    stats.backend,
                    stats.mean_ms,
                    stats.p50_ms,
                    stats.p95_ms,
                    stats.p99_ms,
                    stats.mpix_per_s,
                    speedup
                );
            }
        }
        Ok(())
    }

    fn measure(config: &X11InputConfig, shm: bool, args: &Args) -> anyhow::Result<Stats> {
        // SAFETY: the benchmark is single-threaded and the grabber only reads
        // the variable during construction.
        unsafe {
            if shm {
                std::env::remove_var(DISABLE_SHM_ENV);
            } else {
                std::env::set_var(DISABLE_SHM_ENV, "1");
            }
        }
        let mut grabber = X11Grabber::new(config)?;
        unsafe { std::env::remove_var(DISABLE_SHM_ENV) };
        if grabber.uses_shm() != shm {
            bail!("requested shm={shm} but the grabber chose otherwise");
        }

        for _ in 0..args.warmup {
            grabber.grab()?;
        }
        let mut samples = Vec::with_capacity(args.iterations);
        for _ in 0..args.iterations {
            let start = Instant::now();
            let frame = grabber.grab()?;
            samples.push(start.elapsed().as_secs_f64() * 1000.0);
            drop(frame);
        }
        if grabber.uses_shm() != shm {
            bail!("MIT-SHM fell back to GetImage during the benchmark");
        }
        if samples.is_empty() {
            bail!("--iterations must be at least 1");
        }

        samples.sort_by(f64::total_cmp);
        let percentile = |p: f64| {
            let index = ((samples.len() - 1) as f64 * p).round() as usize;
            samples[index]
        };
        let mean_ms = samples.iter().sum::<f64>() / samples.len() as f64;
        let pixels = f64::from(config.width) * f64::from(config.height);
        Ok(Stats {
            backend: if shm { "MIT-SHM" } else { "GetImage" },
            mean_ms,
            p50_ms: percentile(0.50),
            p95_ms: percentile(0.95),
            p99_ms: percentile(0.99),
            mpix_per_s: pixels / (mean_ms / 1000.0) / 1_000_000.0,
        })
    }
}
