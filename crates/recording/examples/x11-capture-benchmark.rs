//! Compares the X11 grabber's MIT-SHM (`ShmGetImage`) and core `GetImage`
//! backends on root-window grabs. Each sample is a full `X11Grabber::grab`,
//! including the row copy into a freshly allocated ffmpeg BGRZ frame.
//!
//!   scripts/bench-x11.sh            # runs under xvfb-run at 3840x2160x24
//!   scripts/bench-x11.sh --json

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
    use std::time::Instant;

    use anyhow::{Context, anyhow, bail};
    use cap_recording::screen_capture::{X11Grabber, X11InputConfig};
    use clap::Parser;
    use x11rb::connection::{Connection, RequestConnection};
    use x11rb::protocol::shm::{self, ConnectionExt as _};
    use x11rb::protocol::xproto::{
        ChangeGCAux, ConnectionExt as _, CreateGCAux, Rectangle, Window,
    };
    use x11rb::rust_connection::RustConnection;

    const RESOLUTIONS: [(u16, u16); 4] = [(1280, 720), (1920, 1080), (2560, 1440), (3840, 2160)];

    #[derive(Parser)]
    #[command(about = "Benchmark X11 GetImage vs ShmGetImage capture")]
    struct Args {
        #[arg(long, default_value_t = 30)]
        warmup: usize,
        #[arg(long, default_value_t = 300)]
        iters: usize,
        #[arg(long)]
        json: bool,
    }

    #[derive(Clone, Copy, PartialEq)]
    enum Backend {
        GetImage,
        ShmGetImage,
    }

    impl Backend {
        fn name(self) -> &'static str {
            match self {
                Backend::GetImage => "GetImage",
                Backend::ShmGetImage => "ShmGetImage",
            }
        }
    }

    struct Stats {
        mean: f64,
        p50: f64,
        p95: f64,
        p99: f64,
        mpix_per_s: f64,
    }

    impl Stats {
        fn from_samples(mut samples_ms: Vec<f64>, pixels: f64) -> Self {
            samples_ms.sort_by(f64::total_cmp);
            let mean = samples_ms.iter().sum::<f64>() / samples_ms.len() as f64;
            let percentile = |p: f64| {
                let rank = ((p / 100.0) * samples_ms.len() as f64).ceil() as usize;
                samples_ms[rank.clamp(1, samples_ms.len()) - 1]
            };
            Self {
                mean,
                p50: percentile(50.0),
                p95: percentile(95.0),
                p99: percentile(99.0),
                mpix_per_s: pixels / (mean / 1000.0) / 1e6,
            }
        }

        fn to_json(&self) -> serde_json::Value {
            serde_json::json!({
                "mean_ms": self.mean,
                "p50_ms": self.p50,
                "p95_ms": self.p95,
                "p99_ms": self.p99,
                "mpix_per_s": self.mpix_per_s,
            })
        }
    }

    struct SizeResult {
        width: u16,
        height: u16,
        get_image: Stats,
        shm: Stats,
    }

    impl SizeResult {
        fn speedup(&self) -> f64 {
            self.get_image.mean / self.shm.mean
        }
    }

    fn grabber(width: u16, height: u16, backend: Backend) -> anyhow::Result<X11Grabber> {
        let grabber = X11Grabber::with_shm(
            &X11InputConfig {
                display_name: std::env::var("DISPLAY").context("DISPLAY is not set")?,
                window_id: None,
                x: 0,
                y: 0,
                width: u32::from(width),
                height: u32::from(height),
                fps: 30,
                show_cursor: false,
            },
            backend == Backend::ShmGetImage,
        )?;
        if (backend == Backend::ShmGetImage) != grabber.uses_shm() {
            bail!(
                "{width}x{height}: X11Grabber did not select {}",
                backend.name()
            );
        }
        Ok(grabber)
    }

    fn frame_rows(frame: &ffmpeg::frame::Video) -> Vec<u8> {
        let row_bytes = frame.width() as usize * 4;
        let stride = frame.stride(0);
        frame
            .data(0)
            .chunks(stride)
            .take(frame.height() as usize)
            .flat_map(|row| &row[..row_bytes])
            .copied()
            .collect()
    }

    fn paint_pattern(
        conn: &RustConnection,
        root: Window,
        width: u16,
        height: u16,
    ) -> anyhow::Result<()> {
        const CELL: u16 = 96;
        let gc = conn.generate_id()?;
        conn.create_gc(gc, root, &CreateGCAux::new())?;
        for cy in 0..height.div_ceil(CELL) {
            for cx in 0..width.div_ceil(CELL) {
                let seed = u32::from(cx).wrapping_mul(0x9E37_79B9)
                    ^ u32::from(cy).wrapping_mul(0x85EB_CA6B);
                conn.change_gc(gc, &ChangeGCAux::new().foreground(seed & 0x00FF_FFFF))?;
                conn.poly_fill_rectangle(
                    root,
                    gc,
                    &[Rectangle {
                        x: (cx * CELL) as i16,
                        y: (cy * CELL) as i16,
                        width: CELL,
                        height: CELL,
                    }],
                )?;
            }
        }
        conn.free_gc(gc)?;
        conn.get_input_focus()?.reply()?;
        Ok(())
    }

    fn cpu_model() -> String {
        let from_cpuinfo = std::fs::read_to_string("/proc/cpuinfo")
            .ok()
            .and_then(|info| {
                info.lines()
                    .find(|line| line.starts_with("model name"))
                    .and_then(|line| line.split_once(':'))
                    .map(|(_, value)| value.trim().to_string())
            });
        let from_lscpu = || {
            let output = std::process::Command::new("lscpu").output().ok()?;
            String::from_utf8_lossy(&output.stdout)
                .lines()
                .find(|line| line.trim_start().starts_with("Model name:"))
                .and_then(|line| line.split_once(':'))
                .map(|(_, value)| value.trim().to_string())
        };
        let model = from_cpuinfo
            .or_else(from_lscpu)
            .unwrap_or_else(|| "unknown".to_string());
        format!(
            "{model} ({} logical CPUs, {})",
            std::thread::available_parallelism().map_or(0, |n| n.get()),
            std::env::consts::ARCH
        )
    }

    fn time_backend(grabber: &mut X11Grabber, args: &Args) -> anyhow::Result<Vec<f64>> {
        for _ in 0..args.warmup {
            grabber.grab()?;
        }
        let mut samples = Vec::with_capacity(args.iters);
        for _ in 0..args.iters {
            let start = Instant::now();
            let frame = grabber.grab()?;
            samples.push(start.elapsed().as_secs_f64() * 1000.0);
            drop(frame);
        }
        Ok(samples)
    }

    pub fn run() -> anyhow::Result<()> {
        let args = Args::parse();
        if args.iters == 0 {
            bail!("--iters must be at least 1");
        }
        ffmpeg::init().context("init ffmpeg")?;

        let (conn, screen_num) = x11rb::connect(None).context("connect to X server")?;
        let setup = conn.setup();
        let screen = &setup.roots[screen_num];
        let root = screen.root;
        let (screen_w, screen_h) = (screen.width_in_pixels, screen.height_in_pixels);

        let format = setup
            .pixmap_formats
            .iter()
            .find(|f| f.depth == screen.root_depth)
            .ok_or_else(|| anyhow!("no pixmap format for root depth {}", screen.root_depth))?;
        if format.bits_per_pixel != 32 {
            bail!(
                "root depth {} uses {} bpp; only 32 bpp is supported",
                screen.root_depth,
                format.bits_per_pixel
            );
        }

        if conn
            .extension_information(shm::X11_EXTENSION_NAME)?
            .is_none()
        {
            bail!("X server does not advertise MIT-SHM");
        }
        let shm_version = conn.shm_query_version()?.reply()?;

        let cpu = cpu_model();
        let vendor = String::from_utf8_lossy(&setup.vendor).into_owned();
        let server = format!("{vendor} {}", setup.release_number);
        let shm_version = format!(
            "{}.{}",
            shm_version.major_version, shm_version.minor_version
        );

        eprintln!("CPU: {cpu}");
        eprintln!(
            "X server: {server}, screen {screen_w}x{screen_h} depth {}, MIT-SHM {shm_version}",
            screen.root_depth
        );

        paint_pattern(&conn, root, screen_w, screen_h)?;

        let mut results = Vec::new();
        let mut skipped = Vec::new();
        for (width, height) in RESOLUTIONS {
            if width > screen_w || height > screen_h {
                eprintln!("skipping {width}x{height}: larger than {screen_w}x{screen_h} screen");
                skipped.push(format!("{width}x{height}"));
                continue;
            }

            let mut get_image_grabber = grabber(width, height, Backend::GetImage)?;
            let mut shm_grabber = grabber(width, height, Backend::ShmGetImage)?;

            let reference = frame_rows(&get_image_grabber.grab()?);
            if frame_rows(&shm_grabber.grab()?) != reference {
                bail!("{width}x{height}: ShmGetImage pixels differ from GetImage");
            }

            eprintln!("benchmarking {width}x{height} ...");
            let pixels = f64::from(width) * f64::from(height);
            let get_image =
                Stats::from_samples(time_backend(&mut get_image_grabber, &args)?, pixels);
            let shm = Stats::from_samples(time_backend(&mut shm_grabber, &args)?, pixels);
            if !shm_grabber.uses_shm() {
                bail!("{width}x{height}: X11Grabber fell back to GetImage mid-run");
            }
            results.push(SizeResult {
                width,
                height,
                get_image,
                shm,
            });
        }

        if args.json {
            let rows: Vec<_> = results
                .iter()
                .map(|r| {
                    serde_json::json!({
                        "width": r.width,
                        "height": r.height,
                        Backend::GetImage.name(): r.get_image.to_json(),
                        Backend::ShmGetImage.name(): r.shm.to_json(),
                        "speedup": r.speedup(),
                    })
                })
                .collect();
            let report = serde_json::json!({
                "cpu": cpu,
                "x_server": server,
                "screen": { "width": screen_w, "height": screen_h, "depth": screen.root_depth },
                "mit_shm_version": shm_version,
                "pixel_format": "BGRZ",
                "warmup": args.warmup,
                "iters": args.iters,
                "skipped": skipped,
                "results": rows,
            });
            println!("{}", serde_json::to_string_pretty(&report)?);
            return Ok(());
        }

        println!("# X11 capture benchmark: GetImage vs ShmGetImage\n");
        println!("- CPU: {cpu}");
        println!(
            "- X server: {server} ({screen_w}x{screen_h}, depth {})",
            screen.root_depth
        );
        println!("- MIT-SHM: {shm_version}");
        println!(
            "- {} warmup + {} timed grabs per backend, each a full `X11Grabber::grab` including the copy into a new ffmpeg BGRZ frame\n",
            args.warmup, args.iters
        );
        println!(
            "| Resolution | Backend | Mean (ms) | p50 (ms) | p95 (ms) | p99 (ms) | Mpix/s | Speedup |"
        );
        println!("|---|---|---:|---:|---:|---:|---:|---:|");
        for r in &results {
            for (backend, stats) in [
                (Backend::GetImage, &r.get_image),
                (Backend::ShmGetImage, &r.shm),
            ] {
                let speedup = if backend == Backend::ShmGetImage {
                    format!("{:.2}x", r.speedup())
                } else {
                    "1.00x".to_string()
                };
                println!(
                    "| {}x{} | {} | {:.3} | {:.3} | {:.3} | {:.3} | {:.1} | {} |",
                    r.width,
                    r.height,
                    backend.name(),
                    stats.mean,
                    stats.p50,
                    stats.p95,
                    stats.p99,
                    stats.mpix_per_s,
                    speedup
                );
            }
        }
        Ok(())
    }
}
