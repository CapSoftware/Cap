//! Local tool (not for the repo): like encoder-fallback-probe, but records several Studio segments in a row, the way
//! pause and resume do: every segment gets a new screen muxer, its accounting is registered in one recording ledger,
//! and a segment after one that switched to the software encoder opens with Automatic (create_segment_pipeline's rule).
//! encoder-fallback-pause-probe <width> <height> <fps> <segment seconds, comma separated> <auto|hardware> <out_dir>

#[cfg(not(target_os = "macos"))]
fn main() {
    eprintln!("macOS only");
}

#[cfg(target_os = "macos")]
fn main() {
    macos::run();
}

#[cfg(target_os = "macos")]
mod macos {
    use std::path::PathBuf;
    use std::sync::{Arc, atomic::AtomicBool};
    use std::time::{Duration, Instant};

    use cap_enc_ffmpeg::h264::VideoEncoderChoice;
    use cap_media_info::{RawVideoFormat, VideoInfo};
    use cap_recording::screen_capture::{
        self,
        frame_accounting::{FrameLossCarry, ScreenFrameAccounting, ScreenFrameLedger},
    };
    use cap_recording::{
        MacOSFragmentedM4SMuxer, MacOSFragmentedM4SMuxerConfig, Muxer, PipelineHealthEvent,
        TaskPool, VideoMuxer,
    };
    use cidre::{arc, cf, cm, cv};

    fn iosurface_attrs() -> arc::R<cf::Dictionary> {
        let io_surface_properties = cf::Dictionary::new();
        let keys: [&cf::Type; 2] = [
            cv::pixel_buffer::keys::io_surf_props().as_ref(),
            cv::pixel_buffer::keys::metal_compatibility().as_ref(),
        ];
        let values: [&cf::Type; 2] = [
            io_surface_properties.as_ref(),
            cf::Boolean::value_true().as_ref(),
        ];
        cf::Dictionary::with_keys_values(&keys, &values).expect("pixel buffer attributes")
    }

    fn render(width: usize, height: usize, scroll: usize) -> (Vec<u8>, Vec<u8>) {
        let mut y = vec![0u8; width * height];
        for row in 0..height {
            let r = row + scroll;
            let line = (r / 16) % 97;
            let in_line = r % 16;
            for col in 0..width {
                let cell = col / 9;
                let hash = line.wrapping_mul(2_654_435_761) ^ cell.wrapping_mul(40_503);
                let glyph = (3..13).contains(&in_line)
                    && (col % 9) < 7
                    && (hash >> 3) % 3 != 0
                    && (hash >> (((col % 9) + in_line * 7) % 23)) & 1 == 1;
                y[row * width + col] = if glyph { 40 } else { 235 };
            }
        }
        (y, vec![128u8; width * height / 2])
    }

    fn fill(buf: &mut arc::R<cv::PixelBuf>, content: &(Vec<u8>, Vec<u8>), width: usize) {
        unsafe {
            buf.lock_base_addr(cv::pixel_buffer::LockFlags::DEFAULT)
                .result()
                .expect("lock frame");
            for (plane, src) in [(0, &content.0), (1, &content.1)] {
                let stride = buf.plane_bytes_per_row(plane);
                let base = buf.plane_base_address(plane).cast_mut();
                for row in 0..buf.plane_height(plane) {
                    std::ptr::copy_nonoverlapping(
                        src.as_ptr().add(row * width),
                        base.add(row * stride),
                        width,
                    );
                }
            }
            buf.unlock_lock_base_addr(cv::pixel_buffer::LockFlags::DEFAULT);
        }
    }

    pub fn run() {
        let args: Vec<String> = std::env::args().collect();
        let width: usize = args[1].parse().unwrap();
        let height: usize = args[2].parse().unwrap();
        let fps: u32 = args[3].parse().unwrap();
        let segments: Vec<f64> = args[4].split(',').map(|s| s.parse().unwrap()).collect();
        let requested = match args[5].as_str() {
            "hardware" => VideoEncoderChoice::Hardware,
            _ => VideoEncoderChoice::Automatic,
        };
        let out_dir = PathBuf::from(&args[6]);

        tracing_subscriber::fmt()
            .with_env_filter(
                tracing_subscriber::EnvFilter::try_from_default_env()
                    .unwrap_or_else(|_| "info".into()),
            )
            .with_writer(std::io::stderr)
            .with_ansi(false)
            .init();
        ffmpeg::init().unwrap();

        let contents: Vec<_> = (0..24).map(|i| render(width, height, i * 8)).collect();
        let attrs = iosurface_attrs();
        let mut pool: Vec<arc::R<cv::PixelBuf>> = (0..8)
            .map(|_| {
                cv::PixelBuf::new(width, height, cv::PixelFormat::_420V, Some(&attrs))
                    .expect("420v buffer")
            })
            .collect();
        let format_desc = cm::VideoFormatDesc::with_image_buf(&pool[0]).expect("format desc");
        let runtime = tokio::runtime::Runtime::new().unwrap();
        let ledger = ScreenFrameLedger::default();
        let period = Duration::from_secs_f64(1.0 / fps as f64);

        for (index, secs) in segments.iter().enumerate() {
            let choice = if ledger.switched_to_software() {
                VideoEncoderChoice::Automatic
            } else {
                requested
            };
            let dir = out_dir.join(format!("segment-{index}")).join("display");
            let accounting = Arc::new(ScreenFrameAccounting::with_capture_buffers(8));
            ledger.register(accounting.clone());
            let config = MacOSFragmentedM4SMuxerConfig {
                timed_fragments: true,
                video_encoder: choice,
                frame_accounting: Some(accounting.clone()),
                ..Default::default()
            };
            let video_info =
                VideoInfo::from_raw(RawVideoFormat::Nv12, width as u32, height as u32, fps);
            let mut muxer = runtime
                .block_on(MacOSFragmentedM4SMuxer::setup(
                    config,
                    dir.clone(),
                    Some(video_info),
                    None,
                    Arc::new(AtomicBool::new(false)),
                    &mut TaskPool::default(),
                ))
                .expect("muxer setup");
            let (health_tx, mut health_rx) = tokio::sync::mpsc::channel(256);
            muxer.set_health_sender(health_tx);

            let start = Instant::now();
            let slots = (fps as f64 * secs) as u64;
            let mut skipped = 0u64;
            let mut delivered = 0u64;
            for slot in 0..slots {
                let deadline = start + period * slot as u32;
                let now = Instant::now();
                if deadline > now {
                    std::thread::sleep(deadline - now);
                }
                let Some(i) = pool.iter().position(|b| b.retain_count() == 1) else {
                    skipped += 1;
                    continue;
                };
                fill(&mut pool[i], &contents[(slot % 24) as usize], width);
                let timing = cm::SampleTimingInfo {
                    duration: cm::Time::new(1_000_000 / fps as i64, 1_000_000),
                    pts: cm::Time::new(slot as i64 * 1_000_000 / fps as i64, 1_000_000),
                    dts: cm::Time::invalid(),
                };
                let sample_buf = cm::SampleBuf::with_image_buf(
                    &pool[i],
                    true,
                    None,
                    std::ptr::null(),
                    &format_desc,
                    &timing,
                )
                .expect("sample buffer");
                let frame = screen_capture::VideoFrame {
                    sample_buf,
                    timestamp: cap_timestamp::Timestamp::Instant(deadline),
                    capture: Some(FrameLossCarry {
                        capture_skipped: skipped,
                    }),
                };
                skipped = 0;
                delivered += 1;
                muxer
                    .send_video_frame(frame, period * slot as u32)
                    .expect("send frame");
            }
            muxer.stop();
            let finished = muxer.finish(period * slots as u32);
            drop(muxer);
            let mut events = Vec::new();
            while let Ok(event) = health_rx.try_recv() {
                if let PipelineHealthEvent::EncoderRebuilt { backend, .. } = event {
                    events.push(format!("EncoderRebuilt({backend})"));
                }
            }
            let mut files: Vec<PathBuf> = std::fs::read_dir(&dir)
                .expect("segment dir")
                .filter_map(|e| e.ok().map(|e| e.path()))
                .filter(|p| p.extension().is_some_and(|ext| ext == "m4s"))
                .collect();
            files.sort();
            let remux = cap_enc_ffmpeg::remux::concatenate_m4s_segments_with_init(
                &dir.join("init.mp4"),
                &files,
                &dir.with_file_name("display.mp4"),
            );
            let totals = accounting.totals();
            println!(
                "SEGMENT {index} choice={choice:?} secs={secs} delivered={delivered} written={} lost_in_capture={} switched_flag={} events=[{}] finish={} remux={}",
                totals.written,
                totals.lost_in_capture,
                ledger.switched_to_software(),
                events.join(" "),
                match &finished {
                    Ok(Ok(())) => "ok".to_string(),
                    Ok(Err(e)) | Err(e) => format!("{e:#}"),
                },
                remux.is_ok()
            );
        }
    }
}
