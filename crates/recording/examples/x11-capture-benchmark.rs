//! Compares X11 `GetImage`, MIT-SHM publish (no row copy), and MIT-SHM with
//! the previous row copy. Full-grab samples include the X round trip. A
//! separate section times only the row copy and only the SHM publish.
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
    use cap_recording::screen_capture::{X11Grabber, X11InputConfig, copy_x11_image_rows};
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
        ShmRowCopy,
    }

    impl Backend {
        fn name(self) -> &'static str {
            match self {
                Backend::GetImage => "GetImage",
                Backend::ShmGetImage => "ShmPublish",
                Backend::ShmRowCopy => "ShmRowCopy",
            }
        }
    }

    struct Stats {
        samples: usize,
        mean: f64,
        median: f64,
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
            let mid = samples_ms.len() / 2;
            let median = if samples_ms.len().is_multiple_of(2) {
                (samples_ms[mid - 1] + samples_ms[mid]) / 2.0
            } else {
                samples_ms[mid]
            };
            Self {
                samples: samples_ms.len(),
                mean,
                median,
                p50: percentile(50.0),
                p95: percentile(95.0),
                p99: percentile(99.0),
                mpix_per_s: pixels / (mean / 1000.0) / 1e6,
            }
        }

        fn to_json(&self) -> serde_json::Value {
            serde_json::json!({
                "samples": self.samples,
                "mean_ms": self.mean,
                "median_ms": self.median,
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
        row_copy: Stats,
        publish_only: Stats,
        row_copy_only: Stats,
    }

    impl SizeResult {
        fn speedup(&self) -> f64 {
            self.get_image.mean / self.shm.mean
        }

        fn row_copy_savings_ms(&self) -> f64 {
            self.row_copy.median - self.shm.median
        }
    }

    fn grabber(width: u16, height: u16, backend: Backend) -> anyhow::Result<X11Grabber> {
        let mut grabber = X11Grabber::with_shm(
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
            backend != Backend::GetImage,
        )?;
        if backend == Backend::ShmRowCopy {
            grabber.force_shm_row_copy(true);
        }
        if (backend != Backend::GetImage) != grabber.uses_shm() {
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

    fn time_publish(grabber: &mut X11Grabber, args: &Args) -> anyhow::Result<Vec<f64>> {
        grabber.grab()?;
        for _ in 0..args.warmup {
            drop(grabber.publish_idle_shm_frame()?);
        }
        let mut samples = Vec::with_capacity(args.iters);
        for _ in 0..args.iters {
            let start = Instant::now();
            let frame = grabber.publish_idle_shm_frame()?;
            samples.push(start.elapsed().as_secs_f64() * 1000.0);
            drop(frame);
        }
        Ok(samples)
    }

    fn time_row_copy(width: u16, height: u16, args: &Args) -> anyhow::Result<Vec<f64>> {
        let width = usize::from(width);
        let height = usize::from(height);
        let src = vec![7u8; width * height * 4];
        let mut dst =
            ffmpeg::frame::Video::new(ffmpeg::format::Pixel::BGRZ, width as u32, height as u32);
        let once = |dst: &mut ffmpeg::frame::Video| {
            copy_x11_image_rows(&src, width, height, dst).context("row copy")
        };
        for _ in 0..args.warmup {
            once(&mut dst)?;
        }
        let mut samples = Vec::with_capacity(args.iters);
        for _ in 0..args.iters {
            let start = Instant::now();
            once(&mut dst)?;
            samples.push(start.elapsed().as_secs_f64() * 1000.0);
        }
        Ok(samples)
    }

    fn profile_name() -> &'static str {
        if cfg!(debug_assertions) {
            "dev"
        } else {
            "release opt-level=s lto=thin codegen-units=1"
        }
    }

    fn rustc_version() -> String {
        std::process::Command::new("rustc")
            .arg("--version")
            .output()
            .ok()
            .and_then(|output| String::from_utf8(output.stdout).ok())
            .map(|version| version.trim().to_string())
            .unwrap_or_else(|| "unknown".to_string())
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
            let mut row_copy_grabber = grabber(width, height, Backend::ShmRowCopy)?;

            let reference = frame_rows(&get_image_grabber.grab()?);
            if frame_rows(&shm_grabber.grab()?) != reference {
                bail!("{width}x{height}: ShmPublish pixels differ from GetImage");
            }
            if frame_rows(&row_copy_grabber.grab()?) != reference {
                bail!("{width}x{height}: ShmRowCopy pixels differ from GetImage");
            }

            eprintln!("benchmarking {width}x{height} ...");
            let pixels = f64::from(width) * f64::from(height);
            let publish_only = Stats::from_samples(time_publish(&mut shm_grabber, &args)?, pixels);
            let row_copy_only = Stats::from_samples(time_row_copy(width, height, &args)?, pixels);
            let get_image =
                Stats::from_samples(time_backend(&mut get_image_grabber, &args)?, pixels);
            let shm = Stats::from_samples(time_backend(&mut shm_grabber, &args)?, pixels);
            let row_copy = Stats::from_samples(time_backend(&mut row_copy_grabber, &args)?, pixels);
            if !shm_grabber.uses_shm() || !row_copy_grabber.uses_shm() {
                bail!("{width}x{height}: X11Grabber fell back to GetImage mid-run");
            }
            results.push(SizeResult {
                width,
                height,
                get_image,
                shm,
                row_copy,
                publish_only,
                row_copy_only,
            });
        }

        let rustc = rustc_version();
        let profile = profile_name();

        if args.json {
            let rows: Vec<_> = results
                .iter()
                .map(|r| {
                    serde_json::json!({
                        "width": r.width,
                        "height": r.height,
                        Backend::GetImage.name(): r.get_image.to_json(),
                        Backend::ShmGetImage.name(): r.shm.to_json(),
                        Backend::ShmRowCopy.name(): r.row_copy.to_json(),
                        "publish_only": r.publish_only.to_json(),
                        "row_copy_only": r.row_copy_only.to_json(),
                        "full_grab_row_copy_savings_median_ms": r.row_copy_savings_ms(),
                        "isolated_row_copy_savings_median_ms": r.row_copy_only.median - r.publish_only.median,
                        "speedup_vs_get_image": r.speedup(),
                    })
                })
                .collect();
            let report = serde_json::json!({
                "cpu": cpu,
                "rustc": rustc,
                "profile": profile,
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

        println!("# X11 capture benchmark: SHM publish vs row copy\n");
        println!("- CPU: {cpu}");
        println!("- rustc: {rustc}");
        println!("- profile: {profile}");
        println!(
            "- X server: {server} ({screen_w}x{screen_h}, depth {})",
            screen.root_depth
        );
        println!("- MIT-SHM: {shm_version}");
        println!(
            "- {} warmup + {} samples. Full grabs time `X11Grabber::grab`. `row_copy_only` times `copy_image_rows` into a reused frame. `publish_only` wraps the idle SHM mapping with no X round trip.\n",
            args.warmup, args.iters
        );
        println!("| Resolution | Path | Median (ms) | Mean (ms) | p95 (ms) | Samples |");
        println!("|---|---|---:|---:|---:|---:|");
        for r in &results {
            for (path, stats) in [
                ("GetImage grab", &r.get_image),
                ("ShmPublish grab", &r.shm),
                ("ShmRowCopy grab", &r.row_copy),
                ("publish_only", &r.publish_only),
                ("row_copy_only", &r.row_copy_only),
            ] {
                println!(
                    "| {}x{} | {} | {:.4} | {:.4} | {:.4} | {} |",
                    r.width, r.height, path, stats.median, stats.mean, stats.p95, stats.samples
                );
            }
            println!(
                "| {}x{} | isolated savings (row copy - publish) | {:.4} |  |  | {} |",
                r.width,
                r.height,
                r.row_copy_only.median - r.publish_only.median,
                r.row_copy_only.samples
            );
            println!(
                "| {}x{} | full grab savings (row copy - publish) | {:.4} |  |  | {} |",
                r.width,
                r.height,
                r.row_copy_savings_ms(),
                r.shm.samples
            );
        }
        Ok(())
    }
}
