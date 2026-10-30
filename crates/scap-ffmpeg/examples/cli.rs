//! Windows/macOS capture demo. On Windows, `--bench [--seconds N] [--path both|old|new|none]`
//! measures the old two-transfer readback against the zero-copy staging ring on live frames. WGC
//! only produces frames while the captured content changes, so keep something moving during the run.

#[tokio::main]
pub async fn main() {
    #[cfg(windows)]
    {
        use scap_direct3d::*;
        use scap_targets::Display;
        use std::{
            sync::{
                Arc,
                atomic::{AtomicU64, Ordering},
                mpsc,
            },
            time::{Duration, Instant},
        };

        let args: Vec<String> = std::env::args().collect();
        let bench = args.iter().any(|arg| arg == "--bench");
        let seconds = args
            .iter()
            .position(|arg| arg == "--seconds")
            .and_then(|index| args.get(index + 1))
            .and_then(|value| value.parse::<f64>().ok())
            .unwrap_or(15.0)
            .clamp(1.0, 120.0);
        let path = args
            .iter()
            .position(|arg| arg == "--path")
            .and_then(|index| args.get(index + 1))
            .cloned()
            .unwrap_or_else(|| "both".to_string());
        if !matches!(path.as_str(), "both" | "old" | "new" | "none") {
            eprintln!("invalid --path {path}; expected both, old, new, or none");
            std::process::exit(2);
        }

        let display = Display::primary();
        let capture_fps = 60;
        let min_update_interval = Settings::can_min_update_interval()
            .ok()
            .filter(|supported| *supported)
            .map(|_| Duration::from_secs_f64(1.0 / capture_fps as f64));
        let frame_sender = bench.then(|| {
            let (tx, rx) = mpsc::sync_channel::<Frame>(4);
            (tx, rx)
        });
        let callback_drops = Arc::new(AtomicU64::new(0));

        let frame_tx = frame_sender.as_ref().map(|(tx, _)| tx.clone());
        let callback_drops_tx = callback_drops.clone();
        let mut capturer = Capturer::new(
            display.raw_handle().try_as_capture_item().unwrap(),
            Settings {
                is_border_required: Some(true),
                is_cursor_capture_enabled: Some(true),
                pixel_format: PixelFormat::R8G8B8A8Unorm,
                fps: Some(capture_fps),
                min_update_interval,
                ..Default::default()
            },
            move |frame| {
                if let Some(tx) = &frame_tx {
                    if tx.try_send(frame).is_err() {
                        callback_drops_tx.fetch_add(1, Ordering::Relaxed);
                    }
                    return Ok(());
                }

                use scap_ffmpeg::AsFFmpeg;

                match frame.as_ffmpeg() {
                    Ok(ff_frame) => println!(
                        "Frame: {}x{} format={:?}",
                        ff_frame.width(),
                        ff_frame.height(),
                        ff_frame.format()
                    ),
                    Err(error) => eprintln!("Frame conversion failed: {error}"),
                }

                Ok(())
            },
            || Ok(()),
            None,
        )
        .unwrap();

        capturer.start().unwrap();

        if let Some((_, frame_rx)) = frame_sender {
            readback_benchmark(&display, frame_rx, seconds, &path, &callback_drops);
        } else {
            std::thread::sleep(Duration::from_secs(3));
        }

        capturer.stop().unwrap();

        std::thread::sleep(Duration::from_secs(1));

        fn readback_benchmark(
            display: &Display,
            frame_rx: mpsc::Receiver<Frame>,
            seconds: f64,
            path: &str,
            callback_drops: &Arc<AtomicU64>,
        ) {
            use scap_ffmpeg::AsFFmpeg;

            let initial_size = display.physical_size().unwrap();
            let mut last_frame_size = (initial_size.width() as u32, initial_size.height() as u32);

            let mut old = Samples::default();
            let mut new = Samples::default();
            let mut old_frame = None;
            let mut frames_seen = 0u64;
            let run_old_path = path != "new" && path != "none";
            let run_new_path = path != "old" && path != "none";
            let started = Instant::now();

            while started.elapsed() < Duration::from_secs_f64(seconds) {
                let frame = match frame_rx.recv_timeout(Duration::from_secs(1)) {
                    Ok(frame) => frame,
                    Err(mpsc::RecvTimeoutError::Timeout) => continue,
                    Err(mpsc::RecvTimeoutError::Disconnected) => break,
                };
                frames_seen += 1;
                last_frame_size = (frame.width(), frame.height());

                let mut run_old = || {
                    let started = Instant::now();
                    let buffer = frame.as_buffer().ok()?;
                    let width = buffer.width() as usize;
                    let height = buffer.height() as usize;
                    let source_stride = buffer.stride() as usize;
                    let row_length = width * 4;
                    let destination = old_frame.get_or_insert_with(|| {
                        ffmpeg::frame::Video::new(
                            ffmpeg::format::Pixel::RGBA,
                            width as u32,
                            height as u32,
                        )
                    });

                    if destination.width() as usize != width
                        || destination.height() as usize != height
                    {
                        *destination = ffmpeg::frame::Video::new(
                            ffmpeg::format::Pixel::RGBA,
                            width as u32,
                            height as u32,
                        );
                    }

                    let destination_stride = destination.stride(0);
                    let destination_data = destination.data_mut(0);

                    for row in 0..height {
                        unsafe {
                            std::ptr::copy_nonoverlapping(
                                buffer.data().as_ptr().add(row * source_stride),
                                destination_data.as_mut_ptr().add(row * destination_stride),
                                row_length,
                            );
                        }
                    }

                    Some(started.elapsed())
                };

                let run_new = || {
                    let started = Instant::now();
                    match frame.as_ffmpeg() {
                        Ok(_) => Some((started.elapsed(), false)),
                        Err(scap_ffmpeg::AsFFmpegError::NotReady) => {
                            Some((started.elapsed(), true))
                        }
                        Err(error) => {
                            eprintln!("as_ffmpeg failed: {error}");
                            None
                        }
                    }
                };

                let (old_elapsed, new_elapsed) = match path {
                    "old" => (run_old(), None),
                    "new" => (None, run_new()),
                    "none" => (None, None),
                    _ => {
                        let old_first = old.count.is_multiple_of(2);
                        if old_first {
                            (run_old(), run_new())
                        } else {
                            let new_elapsed = run_new();
                            (run_old(), new_elapsed)
                        }
                    }
                };

                if let Some(elapsed) = old_elapsed {
                    old.record(elapsed);
                } else if run_old_path {
                    old.failures += 1;
                }

                match new_elapsed {
                    Some((elapsed, dropped)) => {
                        if dropped {
                            new.dropped += 1;
                        } else {
                            new.record(elapsed);
                        }
                    }
                    None if run_new_path => new.failures += 1,
                    None => {}
                }
            }

            let (last_width, last_height) = last_frame_size;
            let frame_bytes = last_width as u64 * last_height as u64 * 4;
            println!(
                "{}x{} RGBA ({:.1} MiB/frame), {seconds:.0}s, path={path}, callback_drops={}, source_frames={frames_seen}",
                last_width,
                last_height,
                frame_bytes as f64 / (1024.0 * 1024.0),
                callback_drops.load(Ordering::Relaxed)
            );
            println!("old (blocking two-transfer path): {old}");
            println!("new (ring + zero copy): {new}");
            println!(
                "{{\"old\":{},\"new\":{},\"source_frames\":{frames_seen},\"frame_bytes\":{frame_bytes}}}",
                old.json(),
                new.json()
            );
        }

        #[derive(Default)]
        struct Samples {
            count: u64,
            dropped: u64,
            failures: u64,
            elapsed: Vec<Duration>,
        }

        impl Samples {
            fn record(&mut self, elapsed: Duration) {
                self.count += 1;
                self.elapsed.push(elapsed);
            }

            fn mean_ms(&self) -> f64 {
                if self.elapsed.is_empty() {
                    return 0.0;
                }
                self.elapsed
                    .iter()
                    .map(|elapsed| elapsed.as_secs_f64())
                    .sum::<f64>()
                    * 1000.0
                    / self.elapsed.len() as f64
            }

            fn percentile_ms(&self, percentile: f64) -> f64 {
                if self.elapsed.is_empty() {
                    return 0.0;
                }
                let mut sorted = self.elapsed.clone();
                sorted.sort_unstable();
                let index = ((sorted.len() as f64 - 1.0) * percentile).round() as usize;
                sorted[index].as_secs_f64() * 1000.0
            }

            fn json(&self) -> String {
                format!(
                    "{{\"frames\":{},\"dropped\":{},\"failures\":{},\"mean_ms\":{:.3},\"p50_ms\":{:.3},\"p95_ms\":{:.3},\"p99_ms\":{:.3},\"max_ms\":{:.3}}}",
                    self.count,
                    self.dropped,
                    self.failures,
                    self.mean_ms(),
                    self.percentile_ms(0.50),
                    self.percentile_ms(0.95),
                    self.percentile_ms(0.99),
                    self.percentile_ms(1.0)
                )
            }
        }

        impl std::fmt::Display for Samples {
            fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                write!(
                    f,
                    "frames={} dropped={} failures={} mean={:.2}ms p50={:.2}ms p95={:.2}ms p99={:.2}ms max={:.2}ms",
                    self.count,
                    self.dropped,
                    self.failures,
                    self.mean_ms(),
                    self.percentile_ms(0.50),
                    self.percentile_ms(0.95),
                    self.percentile_ms(0.99),
                    self.percentile_ms(1.0)
                )
            }
        }
    }

    #[cfg(target_os = "macos")]
    {
        use std::time::Duration;

        use cidre::sc;
        use scap_screencapturekit::*;
        use scap_targets::Display;

        let display = Display::primary();

        let config = StreamCfgBuilder::default()
            .with_fps(60.0)
            .with_width(display.physical_size().unwrap().width() as usize)
            .with_height(display.physical_size().unwrap().height() as usize)
            .build();

        let content = sc::ShareableContent::current().await.unwrap();
        let capturer = Capturer::builder(
            display.raw_handle().as_content_filter(content).unwrap(),
            config,
        )
        .with_output_sample_buf_cb(|frame| {
            use scap_ffmpeg::AsFFmpeg;

            let Frame::Screen(video_frame) = frame else {
                return;
            };

            let ff_frame = video_frame.as_ffmpeg().unwrap();

            ff_frame.width();
            ff_frame.height();
            ff_frame.format();
        })
        .with_stop_with_err_cb(|_, _| {})
        .build()
        .expect("Failed to build capturer");

        capturer.start().await.expect("Failed to start capturing");

        std::thread::sleep(Duration::from_secs(3));

        capturer.stop().await.expect("Failed to stop capturing");

        std::thread::sleep(Duration::from_secs(1));
    }
}
