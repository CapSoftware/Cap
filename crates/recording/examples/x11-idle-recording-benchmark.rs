#[cfg(not(target_os = "linux"))]
fn main() {
    eprintln!("x11-idle-recording-benchmark: skipped (not Linux)");
}

#[cfg(target_os = "linux")]
fn main() -> anyhow::Result<()> {
    linux::run()
}

#[cfg(target_os = "linux")]
mod linux {
    use std::{
        path::{Path, PathBuf},
        sync::{
            Arc,
            atomic::{AtomicBool, Ordering},
        },
        thread,
        time::{Duration, Instant},
    };

    use anyhow::{Context, bail};
    use cap_recording::{screen_capture::ScreenCaptureTarget, studio_recording};
    use clap::{Parser, ValueEnum};
    use scap_targets::Display;
    use x11rb::{
        connection::Connection,
        protocol::xproto::{
            ChangeGCAux, ConnectionExt as _, CreateGCAux, CreateWindowAux, Rectangle, WindowClass,
        },
        rust_connection::RustConnection,
        wrapper::ConnectionExt as _,
    };

    #[derive(Clone, Copy, PartialEq, Eq, ValueEnum)]
    enum Scene {
        Static,
        Typing,
        Video,
    }

    impl Scene {
        fn name(self) -> &'static str {
            match self {
                Scene::Static => "static",
                Scene::Typing => "typing",
                Scene::Video => "video",
            }
        }
    }

    #[derive(Parser)]
    #[command(about = "Process CPU and encoded frames of a Studio recording of an X11 display")]
    struct Args {
        #[arg(long, default_value_t = 20)]
        seconds: u64,
        #[arg(long, default_value_t = 30)]
        fps: u32,
        #[arg(long = "scene", value_enum)]
        scenes: Vec<Scene>,
        #[arg(long)]
        json: bool,
        #[arg(long)]
        keep: Option<PathBuf>,
    }

    struct Measurement {
        wall: Duration,
        cpu: Duration,
        frames: usize,
        bytes: u64,
        seconds: f64,
    }

    pub fn run() -> anyhow::Result<()> {
        let mut args = Args::parse();
        if args.scenes.is_empty() {
            args.scenes = vec![Scene::Static, Scene::Typing, Scene::Video];
        }
        let size = Display::primary()
            .physical_size()
            .context("primary display has no size")?;
        let runtime = tokio::runtime::Runtime::new()?;

        if !args.json {
            println!(
                "# Studio recording of a {}x{} X11 display at {} fps for {} s\n",
                size.width(),
                size.height(),
                args.fps,
                args.seconds
            );
            println!(
                "| scene | process CPU, % of one core | frames encoded | video seconds | MB written |"
            );
            println!("|---|---|---|---|---|");
        }

        for scene in args.scenes.clone() {
            let result = runtime.block_on(record(scene, &args))?;
            let cpu_percent = result.cpu.as_secs_f64() * 100.0 / result.wall.as_secs_f64();
            if args.json {
                println!(
                    "{}",
                    serde_json::json!({
                        "scene": scene.name(),
                        "width": size.width(),
                        "height": size.height(),
                        "fps": args.fps,
                        "wallSeconds": result.wall.as_secs_f64(),
                        "cpuMs": result.cpu.as_secs_f64() * 1000.0,
                        "cpuPercent": cpu_percent,
                        "frames": result.frames,
                        "videoSeconds": result.seconds,
                        "bytes": result.bytes,
                    })
                );
            } else {
                println!(
                    "| {} | {:.1} | {} | {:.2} | {:.2} |",
                    scene.name(),
                    cpu_percent,
                    result.frames,
                    result.seconds,
                    result.bytes as f64 / 1_000_000.0
                );
            }
        }
        Ok(())
    }

    async fn record(scene: Scene, args: &Args) -> anyhow::Result<Measurement> {
        let (conn, screen) = x11rb::connect(None).context("connect to the X11 display")?;
        let root = conn.setup().roots[screen].root;
        let width = conn.setup().roots[screen].width_in_pixels;
        let height = conn.setup().roots[screen].height_in_pixels;
        let window = conn.generate_id()?;
        conn.create_window(
            x11rb::COPY_DEPTH_FROM_PARENT,
            window,
            root,
            0,
            0,
            width,
            height,
            0,
            WindowClass::INPUT_OUTPUT,
            x11rb::COPY_FROM_PARENT,
            &CreateWindowAux::new()
                .override_redirect(1)
                .background_pixel(0x1e1e1e),
        )?;
        conn.map_window(window)?;
        fill_background(&conn, window, width, height)?;

        let directory = tempfile::tempdir()?;
        let project = match &args.keep {
            Some(keep) => keep.join(format!("{}.cap", scene.name())),
            None => directory.path().join("benchmark.cap"),
        };
        let handle = studio_recording::Actor::builder(
            project.clone(),
            ScreenCaptureTarget::Display {
                id: Display::primary().id(),
            },
        )
        .with_system_audio(false)
        .with_keyboard_capture(false)
        .with_max_fps(args.fps)
        .build()
        .await?;

        let stop = Arc::new(AtomicBool::new(false));
        let painter = {
            let stop = Arc::clone(&stop);
            thread::spawn(move || paint(scene, conn, window, width, height, &stop))
        };

        let cpu_start = process_cpu();
        let started = Instant::now();
        tokio::time::sleep(Duration::from_secs(args.seconds)).await;
        stop.store(true, Ordering::Relaxed);
        painter
            .join()
            .map_err(|_| anyhow::anyhow!("the painter thread panicked"))??;
        handle.stop().await?;
        let wall = started.elapsed();
        let cpu = process_cpu().saturating_sub(cpu_start);

        let (frames, bytes, seconds) =
            count_frames(&project.join("content/segments/segment-0/display"))?;
        Ok(Measurement {
            wall,
            cpu,
            frames,
            bytes,
            seconds,
        })
    }

    fn rect(x: u16, y: u16, width: u16, height: u16) -> Rectangle {
        Rectangle {
            x: x as i16,
            y: y as i16,
            width,
            height,
        }
    }

    fn fill_background(
        conn: &RustConnection,
        window: u32,
        width: u16,
        height: u16,
    ) -> anyhow::Result<()> {
        let gc = conn.generate_id()?;
        conn.create_gc(gc, window, &CreateGCAux::new().foreground(0x1e1e1e))?;
        conn.poly_fill_rectangle(window, gc, &[rect(0, 0, width, height)])?;
        conn.free_gc(gc)?;
        conn.sync()?;
        Ok(())
    }

    fn paint(
        scene: Scene,
        conn: RustConnection,
        window: u32,
        width: u16,
        height: u16,
        stop: &AtomicBool,
    ) -> anyhow::Result<()> {
        let gc = conn.generate_id()?;
        conn.create_gc(gc, window, &CreateGCAux::new())?;
        let interval = match scene {
            Scene::Static => Duration::from_millis(100),
            Scene::Typing => Duration::from_millis(125),
            Scene::Video => Duration::from_secs(1) / 30,
        };
        let columns = u32::from(width.saturating_sub(200) / 12).max(1);
        let rows = u32::from(height.saturating_sub(200) / 24).max(1);
        let video_width = width.min(1280);
        let video_height = height.min(720);
        let mut step = 0u32;
        let mut next = Instant::now();
        while !stop.load(Ordering::Relaxed) {
            match scene {
                Scene::Static => {}
                Scene::Typing => {
                    let column = step % columns;
                    let row = (step / columns) % rows;
                    if column == 0 && row == 0 {
                        conn.change_gc(gc, &ChangeGCAux::new().foreground(0x1e1e1e))?;
                        conn.poly_fill_rectangle(
                            window,
                            gc,
                            &[rect(100, 100, width - 200, height - 200)],
                        )?;
                    }
                    conn.change_gc(gc, &ChangeGCAux::new().foreground(0xd4d4d4))?;
                    conn.poly_fill_rectangle(
                        window,
                        gc,
                        &[rect(
                            100 + (column * 12) as u16,
                            100 + (row * 24) as u16,
                            9,
                            16,
                        )],
                    )?;
                }
                Scene::Video => {
                    let stripes = 32u16;
                    let stripe_width = video_width / stripes;
                    for index in 0..stripes {
                        let shade = (u32::from(index) * 8 + step * 5) & 0xff;
                        conn.change_gc(
                            gc,
                            &ChangeGCAux::new()
                                .foreground((shade << 16) | ((255 - shade) << 8) | 0x40),
                        )?;
                        conn.poly_fill_rectangle(
                            window,
                            gc,
                            &[rect(index * stripe_width, 0, stripe_width, video_height)],
                        )?;
                    }
                }
            }
            conn.flush()?;
            step = step.wrapping_add(1);
            next += interval;
            thread::sleep(next.saturating_duration_since(Instant::now()));
        }
        conn.free_gc(gc)?;
        conn.destroy_window(window)?;
        conn.sync()?;
        Ok(())
    }

    fn count_frames(directory: &Path) -> anyhow::Result<(usize, u64, f64)> {
        let mut media = std::fs::read(directory.join("init.mp4"))?;
        let mut segments = std::fs::read_dir(directory)?
            .filter_map(|entry| entry.ok().map(|entry| entry.path()))
            .filter(|path| path.extension().is_some_and(|extension| extension == "m4s"))
            .collect::<Vec<_>>();
        segments.sort();
        for segment in &segments {
            media.extend(std::fs::read(segment)?);
        }
        let bytes = media.len() as u64;
        let joined = tempfile::Builder::new().suffix(".mp4").tempfile()?;
        std::fs::write(joined.path(), &media)?;

        ffmpeg::init()?;
        let mut input = ffmpeg::format::input(joined.path())?;
        let Some(stream) = input.streams().best(ffmpeg::media::Type::Video) else {
            bail!("the recording has no video stream");
        };
        let index = stream.index();
        let time_base = f64::from(stream.time_base());
        let mut frames = 0;
        let mut end = 0i64;
        for (stream, packet) in input.packets() {
            if stream.index() != index {
                continue;
            }
            frames += 1;
            end = end.max(packet.pts().unwrap_or(0) + packet.duration());
        }
        Ok((frames, bytes, end as f64 * time_base))
    }

    fn process_cpu() -> Duration {
        let mut usage = std::mem::MaybeUninit::<libc::rusage>::zeroed();
        let usage = unsafe {
            libc::getrusage(libc::RUSAGE_SELF, usage.as_mut_ptr());
            usage.assume_init()
        };
        let time = |value: libc::timeval| {
            Duration::from_secs(value.tv_sec as u64) + Duration::from_micros(value.tv_usec as u64)
        };
        time(usage.ru_utime) + time(usage.ru_stime)
    }
}
