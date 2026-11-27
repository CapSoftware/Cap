//! Local tool (not for the repo): drives the real Studio screen muxer
//! (MacOSFragmentedM4SMuxer) with a paced feed from a fixed set of IOSurface
//! capture buffers, the way ScreenCaptureKit recycles its queue: a slot whose
//! buffers are all still held downstream is skipped and counted as a capture
//! gap on the next frame.
//! encoder-fallback-probe <width> <height> <fps> <seconds> <auto|hardware> <out_dir> [buffers]

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
        frame_accounting::{FrameLossCarry, ScreenFrameAccounting},
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

    struct Content {
        y: Vec<u8>,
        uv: Vec<u8>,
    }

    /// Dark glyph-like blocks on a light page, scrolled: a document being
    /// scrolled, so every frame changes.
    fn render(width: usize, height: usize, scroll: usize) -> Content {
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
        let mut uv = vec![128u8; width * height / 2];
        for row in 0..height / 2 {
            let tint = ((row + scroll / 2) % 64) as u8;
            for pair in 0..width / 2 {
                uv[row * width + pair * 2] = 128u8.wrapping_add(tint / 4);
            }
        }
        Content { y, uv }
    }

    fn fill(buf: &mut arc::R<cv::PixelBuf>, content: &Content, width: usize) {
        unsafe {
            buf.lock_base_addr(cv::pixel_buffer::LockFlags::DEFAULT)
                .result()
                .expect("lock frame");
            for (plane, src) in [(0, &content.y), (1, &content.uv)] {
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
        let seconds: u64 = args[4].parse().unwrap();
        let choice = match args[5].as_str() {
            "hardware" => VideoEncoderChoice::Hardware,
            _ => VideoEncoderChoice::Automatic,
        };
        let out_dir = PathBuf::from(&args[6]);
        let buffers: usize = args.get(7).map_or(8, |b| b.parse().unwrap());

        tracing_subscriber::fmt()
            .with_env_filter(
                tracing_subscriber::EnvFilter::try_from_default_env()
                    .unwrap_or_else(|_| "info".into()),
            )
            .with_writer(std::io::stderr)
            .with_ansi(false)
            .init();
        ffmpeg::init().unwrap();

        let contents: Vec<Content> = (0..24).map(|i| render(width, height, i * 8)).collect();
        let attrs = iosurface_attrs();
        let mut pool: Vec<arc::R<cv::PixelBuf>> = (0..buffers)
            .map(|_| {
                cv::PixelBuf::new(width, height, cv::PixelFormat::_420V, Some(&attrs))
                    .expect("420v buffer")
            })
            .collect();
        let format_desc = cm::VideoFormatDesc::with_image_buf(&pool[0]).expect("format desc");

        let runtime = tokio::runtime::Runtime::new().unwrap();
        let accounting = Arc::new(ScreenFrameAccounting::with_capture_buffers(buffers as u64));
        let config = MacOSFragmentedM4SMuxerConfig {
            timed_fragments: true,
            video_encoder: choice,
            frame_accounting: Some(accounting.clone()),
            ..Default::default()
        };
        let video_info = VideoInfo::from_raw(RawVideoFormat::Nv12, width as u32, height as u32, fps);
        let mut tasks = TaskPool::default();
        let mut muxer = runtime
            .block_on(MacOSFragmentedM4SMuxer::setup(
                config,
                out_dir.clone(),
                Some(video_info),
                None,
                Arc::new(AtomicBool::new(false)),
                &mut tasks,
            ))
            .expect("muxer setup");
        let (health_tx, mut health_rx) = tokio::sync::mpsc::channel(256);
        muxer.set_health_sender(health_tx);

        let period = Duration::from_secs_f64(1.0 / fps as f64);
        let start = Instant::now();
        let slots = fps as u64 * seconds;
        let mut skipped = 0u64;
        let mut delivered = 0u64;
        let mut total_skipped = 0u64;
        let mut held_at_gap = [0u64; 33];
        let mut second = (0u64, 0u64);
        let mut last_print = 0u64;
        for slot in 0..slots {
            let deadline = start + period * slot as u32;
            let now = Instant::now();
            if deadline > now {
                std::thread::sleep(deadline - now);
            }
            let held = pool.iter().filter(|b| b.retain_count() > 1).count();
            let Some(index) = pool.iter().position(|b| b.retain_count() == 1) else {
                skipped += 1;
                total_skipped += 1;
                second.1 += 1;
                continue;
            };
            if skipped > 0 {
                held_at_gap[held.min(32)] += 1;
            }
            fill(&mut pool[index], &contents[(slot % 24) as usize], width);
            let pts = cm::Time::new(slot as i64 * 1_000_000 / fps as i64, 1_000_000);
            let timing = cm::SampleTimingInfo {
                duration: cm::Time::new(1_000_000 / fps as i64, 1_000_000),
                pts,
                dts: cm::Time::invalid(),
            };
            let sample_buf = cm::SampleBuf::with_image_buf(
                &pool[index],
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
            second.0 += 1;
            muxer
                .send_video_frame(frame, period * slot as u32)
                .expect("send frame");
            let elapsed = start.elapsed().as_secs();
            if elapsed > last_print {
                last_print = elapsed;
                eprintln!(
                    "PROBE second={elapsed} delivered={} skipped={} held_now={held}",
                    second.0, second.1
                );
                second = (0, 0);
            }
        }
        muxer.stop();
        let finished = muxer.finish(period * slots as u32);
        let wall = start.elapsed().as_secs_f64();
        drop(muxer);
        let mut segments: Vec<PathBuf> = std::fs::read_dir(&out_dir)
            .expect("read segment dir")
            .filter_map(|e| e.ok().map(|e| e.path()))
            .filter(|p| p.extension().is_some_and(|ext| ext == "m4s"))
            .collect();
        segments.sort();
        let remux = cap_enc_ffmpeg::remux::concatenate_m4s_segments_with_init(
            &out_dir.join("init.mp4"),
            &segments,
            &out_dir.with_file_name("display.mp4"),
        );
        eprintln!("PROBE remux {} segments: {remux:?}", segments.len());

        let mut events = Vec::new();
        while let Ok(event) = health_rx.try_recv() {
            events.push(match event {
                PipelineHealthEvent::EncoderRebuilt { backend, attempt } => {
                    format!("EncoderRebuilt({backend},{attempt})")
                }
                PipelineHealthEvent::FramesLost {
                    displayed,
                    lost_in_capture,
                    lost_before_encoder,
                    lost_in_encoder,
                    ..
                } => format!(
                    "FramesLost({displayed},{lost_in_capture},{lost_before_encoder},{lost_in_encoder})"
                ),
                other => format!("{other:?}"),
            });
        }
        let totals = accounting.totals();
        let gaps: Vec<String> = held_at_gap
            .iter()
            .enumerate()
            .filter(|(_, n)| **n > 0)
            .map(|(held, n)| format!("{held}:{n}"))
            .collect();
        println!(
            "{{\"width\":{width},\"height\":{height},\"fps\":{fps},\"seconds\":{seconds},\"choice\":\"{:?}\",\"buffers\":{buffers},\"slots\":{slots},\"delivered\":{delivered},\"skipped\":{total_skipped},\"wall\":{wall:.2},\"finish\":\"{}\",\"displayed\":{},\"written\":{},\"lost_in_capture\":{},\"lost_before_encoder\":{},\"lost_in_encoder\":{},\"held_at_gap\":\"{}\",\"events\":\"{}\"}}",
            choice,
            match &finished {
                Ok(Ok(())) => "ok".to_string(),
                Ok(Err(e)) | Err(e) => format!("{e:#}").replace('"', "'"),
            },
            totals.displayed,
            totals.written,
            totals.lost_in_capture,
            totals.lost_before_encoder,
            totals.lost_in_encoder,
            gaps.join(" "),
            events.join(" ")
        );
    }
}
