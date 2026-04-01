#[cfg(not(target_os = "macos"))]
fn main() {
    eprintln!("camera-writer-repro is only available on macOS");
}

#[cfg(target_os = "macos")]
fn main() -> anyhow::Result<()> {
    use cap_camera::{CameraInfo, CapturedFrame, Format};
    use cap_camera_ffmpeg::CapturedFrameExt;
    use cap_enc_avfoundation::{MP4Encoder, QueueFrameError};
    use cap_media_info::VideoInfo;
    use cidre::{arc, cm};
    use std::{
        cmp::Ordering,
        env,
        path::PathBuf,
        sync::mpsc::sync_channel,
        time::{Duration, Instant},
    };

    #[derive(Clone)]
    struct ObservedFrame {
        sample_buf: arc::R<cm::SampleBuf>,
        timestamp: Duration,
        subtype: String,
        width: u32,
        height: u32,
        ffmpeg_video_info: Option<VideoInfo>,
        ffmpeg_error: Option<String>,
    }

    #[derive(Clone)]
    struct ProbeTarget {
        camera: CameraInfo,
        format: Format,
    }

    #[derive(Clone)]
    struct ProbeSummary {
        camera_name: String,
        width: u32,
        height: u32,
        fps: f32,
        received: usize,
        queue_failures: Vec<String>,
        ffmpeg_failures: Vec<String>,
        elapsed_ms: u128,
    }

    unsafe impl Send for ObservedFrame {}
    unsafe impl Sync for ObservedFrame {}

    fn bool_flag(args: &[String], flag: &str) -> bool {
        args.iter().any(|arg| arg == flag)
    }

    fn value_flag(args: &[String], flag: &str) -> Option<String> {
        args.windows(2)
            .find(|window| window[0] == flag)
            .map(|window| window[1].clone())
    }

    fn select_camera(
        cameras: &[CameraInfo],
        preferred: Option<&str>,
    ) -> anyhow::Result<CameraInfo> {
        if let Some(camera) = preferred.and_then(|preferred_name| {
            cameras
                .iter()
                .find(|camera| camera.display_name().contains(preferred_name))
        }) {
            return Ok(camera.clone());
        }

        if let Some(camera) = cameras
            .iter()
            .find(|camera| camera.display_name() == "MacBook Pro Camera")
        {
            return Ok(camera.clone());
        }

        if let Some(camera) = cameras
            .iter()
            .find(|camera| !camera.display_name().contains("Desk View"))
        {
            return Ok(camera.clone());
        }

        cameras
            .first()
            .cloned()
            .ok_or_else(|| anyhow::anyhow!("No cameras available"))
    }

    fn sorted_formats(camera: &CameraInfo) -> anyhow::Result<Vec<Format>> {
        let mut formats = camera
            .formats()
            .ok_or_else(|| anyhow::anyhow!("No formats reported for {}", camera.display_name()))?;

        formats.sort_by(|a, b| {
            let target_aspect_ratio = 16.0 / 9.0;
            let aspect_ratio_a = a.width() as f32 / a.height() as f32;
            let aspect_ratio_b = b.width() as f32 / b.height() as f32;
            let aspect_cmp_a = (aspect_ratio_a - target_aspect_ratio).abs();
            let aspect_cmp_b = (aspect_ratio_b - target_aspect_ratio).abs();
            let aspect_cmp = aspect_cmp_a.partial_cmp(&aspect_cmp_b);
            let resolution_cmp = (a.width() * a.height()).cmp(&(b.width() * b.height()));
            let fr_cmp = a.frame_rate().partial_cmp(&b.frame_rate());

            aspect_cmp
                .unwrap_or(Ordering::Equal)
                .then(resolution_cmp.reverse())
                .then(fr_cmp.unwrap_or(Ordering::Equal).reverse())
        });

        Ok(formats)
    }

    fn choose_default_format(camera: &CameraInfo) -> anyhow::Result<Format> {
        let formats = sorted_formats(camera)?;
        if let Some(format) = formats.iter().find(|format| {
            format.frame_rate() >= 30.0 && format.width() < 2000 && format.height() < 2000
        }) {
            return Ok(format.clone());
        }

        formats
            .first()
            .cloned()
            .ok_or_else(|| anyhow::anyhow!("No usable formats for {}", camera.display_name()))
    }

    fn collect_probe_targets(
        all_cameras: bool,
        format_limit: usize,
        preferred_camera: Option<&str>,
    ) -> anyhow::Result<Vec<ProbeTarget>> {
        let cameras = cap_camera::list_cameras().collect::<Vec<_>>();
        let selected_cameras = if all_cameras {
            cameras
        } else {
            vec![select_camera(&cameras, preferred_camera)?]
        };

        let mut targets = Vec::new();

        for camera in selected_cameras {
            let formats = sorted_formats(&camera)?;

            if format_limit <= 1 {
                targets.push(ProbeTarget {
                    camera: camera.clone(),
                    format: choose_default_format(&camera)?,
                });
                continue;
            }

            for format in formats.into_iter().take(format_limit) {
                targets.push(ProbeTarget {
                    camera: camera.clone(),
                    format,
                });
            }
        }

        Ok(targets)
    }

    fn observe_frame(frame: &CapturedFrame, fps: u32) -> ObservedFrame {
        let sample_buf = frame.native().sample_buf().clone();
        let (subtype, width, height) = match sample_buf.image_buf() {
            Some(image_buf) => {
                let width = image_buf.width() as u32;
                let height = image_buf.height() as u32;
                let subtype = sample_buf
                    .format_desc()
                    .map(|desc| {
                        let mut bytes = desc.media_sub_type().to_be_bytes();
                        cidre::four_cc_to_str(&mut bytes).to_string()
                    })
                    .unwrap_or_else(|| "unknown".to_string());
                (subtype, width, height)
            }
            None => ("no-image-buf".to_string(), 0, 0),
        };

        let (ffmpeg_video_info, ffmpeg_error) = match frame.as_ffmpeg() {
            Ok(ff_frame) => (
                Some(VideoInfo::from_raw_ffmpeg(
                    ff_frame.format(),
                    ff_frame.width(),
                    ff_frame.height(),
                    fps,
                )),
                None,
            ),
            Err(error) => (None, Some(error.to_string())),
        };

        ObservedFrame {
            sample_buf,
            timestamp: frame.timestamp,
            subtype,
            width,
            height,
            ffmpeg_video_info,
            ffmpeg_error,
        }
    }

    fn run_probe(
        target: ProbeTarget,
        frame_limit: usize,
        timeout_secs: u64,
    ) -> anyhow::Result<ProbeSummary> {
        let fps = target.format.frame_rate().round().max(1.0) as u32;
        let output_path = PathBuf::from(format!(
            "/tmp/cap-camera-writer-repro-{}-{}x{}-{}.mp4",
            target.camera.display_name().replace(' ', "-"),
            target.format.width(),
            target.format.height(),
            fps
        ));
        let _ = std::fs::remove_file(&output_path);

        println!(
            "Probe camera='{}' format={}x{} @ {:.2}fps output={}",
            target.camera.display_name(),
            target.format.width(),
            target.format.height(),
            target.format.frame_rate(),
            output_path.display()
        );

        let (tx, rx) = sync_channel::<ObservedFrame>(frame_limit.max(1) * 2);
        let started = Instant::now();
        let handle = target
            .camera
            .start_capturing(target.format.clone(), move |frame| {
                let observed = observe_frame(&frame, fps);
                let _ = tx.try_send(observed);
            })?;

        let mut encoder: Option<MP4Encoder> = None;
        let mut received = 0usize;
        let mut first_timestamp = None;
        let mut queue_failures = Vec::new();
        let mut ffmpeg_failures = Vec::new();
        let deadline = Instant::now() + Duration::from_secs(timeout_secs);

        while received < frame_limit && Instant::now() < deadline {
            let remaining = deadline.saturating_duration_since(Instant::now());
            let Ok(frame) = rx.recv_timeout(remaining.min(Duration::from_millis(500))) else {
                continue;
            };

            let first = *first_timestamp.get_or_insert(frame.timestamp);
            let rel_ms = frame.timestamp.saturating_sub(first).as_millis();
            let timing = frame.sample_buf.timing_info(0).ok();
            let pts_us = timing
                .as_ref()
                .map(|timing| timing.pts.value * 1_000_000 / timing.pts.scale.max(1) as i64);
            let dur_us = timing.as_ref().map(|timing| {
                timing.duration.value * 1_000_000 / timing.duration.scale.max(1) as i64
            });

            println!(
                "frame={received} rel_ms={rel_ms} subtype={} size={}x{} pts_us={pts_us:?} dur_us={dur_us:?}",
                frame.subtype, frame.width, frame.height
            );

            if let Some(error) = &frame.ffmpeg_error {
                ffmpeg_failures.push(error.clone());
            }

            if encoder.is_none() {
                if let Some(video_info) = frame.ffmpeg_video_info {
                    encoder = Some(
                        MP4Encoder::init(output_path.clone(), video_info, None, None)
                            .map_err(|error| anyhow::anyhow!(error.to_string()))?,
                    );
                } else {
                    break;
                }
            }

            let result = encoder
                .as_mut()
                .expect("encoder initialized")
                .queue_video_frame(frame.sample_buf.clone(), frame.timestamp);

            println!("queue_result={result:?}");

            match result {
                Ok(()) | Err(QueueFrameError::NotReadyForMore) => {}
                Err(QueueFrameError::WriterFailed(err)) => {
                    queue_failures.push(format!("WriterFailed/{err}"));
                    break;
                }
                Err(QueueFrameError::Failed) => {
                    queue_failures.push("Failed".to_string());
                    break;
                }
                Err(QueueFrameError::Finished) => {
                    queue_failures.push("Finished".to_string());
                    break;
                }
                Err(err) => {
                    queue_failures.push(err.to_string());
                    break;
                }
            }

            received += 1;
        }

        drop(handle);

        if let Some(mut encoder) = encoder {
            let finish_ts = first_timestamp
                .map(|first| first + Duration::from_secs(2))
                .unwrap_or(Duration::from_secs(1));
            let finish_result = encoder.finish(Some(finish_ts));
            println!("finish_result={finish_result:?}");
        }

        Ok(ProbeSummary {
            camera_name: target.camera.display_name().to_string(),
            width: target.format.width(),
            height: target.format.height(),
            fps: target.format.frame_rate(),
            received,
            queue_failures,
            ffmpeg_failures,
            elapsed_ms: started.elapsed().as_millis(),
        })
    }

    let args = env::args().collect::<Vec<_>>();
    let preferred_camera =
        value_flag(&args, "--camera").or_else(|| env::var("CAP_CAMERA_NAME").ok());
    let frame_limit = value_flag(&args, "--frames")
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or(12);
    let timeout_secs = value_flag(&args, "--timeout")
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(8);
    let format_limit = value_flag(&args, "--formats")
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or(1);
    let all_cameras = bool_flag(&args, "--all-cameras");
    let list_only = bool_flag(&args, "--list");

    let targets = collect_probe_targets(all_cameras, format_limit, preferred_camera.as_deref())?;

    if targets.is_empty() {
        return Err(anyhow::anyhow!("No probe targets"));
    }

    if list_only {
        for target in &targets {
            println!(
                "camera='{}' format={}x{} @ {:.2}fps",
                target.camera.display_name(),
                target.format.width(),
                target.format.height(),
                target.format.frame_rate()
            );
        }
        return Ok(());
    }

    let mut summaries = Vec::new();

    for target in targets {
        let summary = run_probe(target, frame_limit, timeout_secs)?;
        println!(
            "summary camera='{}' format={}x{} @ {:.2}fps received={} queue_failures={:?} ffmpeg_failures={:?} elapsed_ms={}",
            summary.camera_name,
            summary.width,
            summary.height,
            summary.fps,
            summary.received,
            summary.queue_failures,
            summary.ffmpeg_failures,
            summary.elapsed_ms
        );
        summaries.push(summary);
    }

    println!("final_summaries={}", summaries.len());

    Ok(())
}
