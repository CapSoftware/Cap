//! The Studio and Instant recording actors, camera-only (the one capture
//! target that needs no screen capture permission), fed by synthetic camera
//! and microphone feeds and driven through hostile control sequences, then
//! finalized like the app.

use super::harness::Probe;

#[cfg(target_os = "macos")]
mod mac {
    use std::{sync::Arc, time::Duration};

    use cap_media_info::{Pixel, RawVideoFormat, VideoInfo};
    use cap_recording::{
        NativeCameraFrame,
        feeds::{camera::synthetic::SyntheticCamera, microphone::synthetic::SyntheticMicrophone},
        instant_recording,
        recovery::RecoveryManager,
        screen_capture::ScreenCaptureTarget,
        studio_recording,
    };
    use cap_timestamp::{MachAbsoluteTimestamp, Timestamp};

    use super::super::{
        harness::{Ctx, Probe, Verdict},
        media_check,
    };

    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    pub enum Mode {
        Studio,
        Instant,
    }

    #[derive(Clone, Copy, Debug, PartialEq)]
    pub enum Step {
        /// Camera and mic frames for this many seconds.
        Frames(f64),
        Pause,
        Resume,
        Stop,
        Cancel,
        /// Stop and cancel at the same time.
        StopAndCancel,
        /// The camera handle goes away: frames stop, the feed stays.
        StallCamera,
        /// The microphone handle goes away: samples stop, the feed stays.
        StallMic,
        /// The camera feed loses its device (`RemoveInput`).
        DisconnectCamera,
        /// The microphone feed loses its device (`RemoveInput`).
        DisconnectMic,
        /// The camera switches to this size and format.
        CameraShape(u32, u32, Pixel),
        /// Camera timestamps run backwards from here.
        CameraBackwards,
    }

    pub struct Sequence {
        pub name: &'static str,
        pub camera_info: VideoInfo,
        pub steps: Vec<Step>,
        pub expect_media: bool,
    }

    fn nv12(w: u32, h: u32, fps: u32) -> VideoInfo {
        VideoInfo::from_raw(RawVideoFormat::Nv12, w, h, fps)
    }

    pub fn sequences() -> Vec<Sequence> {
        use Step::*;
        let seq = |name, steps: Vec<Step>, expect_media| Sequence {
            name,
            camera_info: nv12(320, 240, 30),
            steps,
            expect_media,
        };
        vec![
            seq("control", vec![Frames(1.0), Stop], true),
            seq("stop-before-first-frame", vec![Stop], false),
            seq("stop-twice", vec![Frames(0.6), Stop, Stop], true),
            seq(
                "pause-before-first-frame",
                vec![Pause, Frames(0.4), Resume, Frames(0.6), Stop],
                true,
            ),
            seq(
                "pause-resume-storm",
                vec![
                    Frames(0.3),
                    Pause,
                    Resume,
                    Pause,
                    Pause,
                    Resume,
                    Resume,
                    Pause,
                    Frames(0.2),
                    Resume,
                    Pause,
                    Stop,
                ],
                true,
            ),
            seq(
                "resume-without-pause",
                vec![Resume, Frames(0.6), Stop],
                true,
            ),
            seq("cancel-then-stop", vec![Frames(0.5), Cancel, Stop], false),
            seq(
                "stop-and-cancel-together",
                vec![Frames(0.5), StopAndCancel],
                false,
            ),
            seq("pause-then-stop", vec![Frames(0.5), Pause, Stop], true),
            seq(
                "camera-stalls",
                vec![Frames(0.5), StallCamera, Frames(0.5), Stop],
                true,
            ),
            seq(
                "mic-stalls",
                vec![Frames(0.5), StallMic, Frames(0.5), Stop],
                true,
            ),
            seq(
                "camera-disconnects",
                vec![Frames(0.5), DisconnectCamera, Frames(0.5), Stop],
                true,
            ),
            seq(
                "mic-disconnects",
                vec![Frames(0.5), DisconnectMic, Frames(0.5), Stop],
                true,
            ),
            seq(
                "camera-size-changes",
                vec![
                    Frames(0.3),
                    CameraShape(640, 480, Pixel::NV12),
                    Frames(0.3),
                    CameraShape(161, 91, Pixel::NV12),
                    Frames(0.3),
                    Stop,
                ],
                true,
            ),
            seq(
                "camera-format-changes",
                vec![
                    Frames(0.3),
                    CameraShape(320, 240, Pixel::BGRA),
                    Frames(0.3),
                    CameraShape(320, 240, Pixel::UYVY422),
                    Frames(0.3),
                    Stop,
                ],
                true,
            ),
            seq(
                "camera-ts-backwards",
                vec![Frames(0.4), CameraBackwards, Frames(0.4), Stop],
                true,
            ),
            Sequence {
                name: "camera-info-zero",
                camera_info: nv12(0, 0, 0),
                steps: vec![Frames(0.6), Stop],
                expect_media: false,
            },
            Sequence {
                name: "camera-info-fps-1000",
                camera_info: nv12(320, 240, 1000),
                steps: vec![Frames(0.6), Stop],
                expect_media: true,
            },
        ]
    }

    enum Handle {
        Studio(studio_recording::ActorHandle),
        Instant(instant_recording::ActorHandle),
    }

    impl Handle {
        async fn pause(&self) -> anyhow::Result<()> {
            match self {
                Handle::Studio(h) => h.pause().await,
                Handle::Instant(h) => h.pause().await,
            }
        }
        async fn resume(&self) -> anyhow::Result<()> {
            match self {
                Handle::Studio(h) => h.resume().await,
                Handle::Instant(h) => h.resume().await,
            }
        }
        async fn cancel(&self) -> anyhow::Result<()> {
            match self {
                Handle::Studio(h) => h.cancel().await,
                Handle::Instant(h) => h.cancel().await,
            }
        }
        async fn stop(&self) -> anyhow::Result<()> {
            match self {
                Handle::Studio(h) => h.stop().await.map(|_| ()),
                Handle::Instant(h) => h.stop().await.map(|_| ()),
            }
        }
    }

    fn host_now() -> u64 {
        cidre::mach::abs_time()
    }

    fn camera_frame(
        width: u32,
        height: u32,
        format: Pixel,
        index: u32,
        at: u64,
    ) -> Option<NativeCameraFrame> {
        let sample_buf = super::super::record::mac_sample(format, width, height, 30, index).ok()?;
        Some(NativeCameraFrame {
            sample_buf,
            timestamp: Timestamp::MachAbsoluteTime(MachAbsoluteTimestamp::new(at)),
        })
    }

    fn ticks(secs: f64) -> u64 {
        let info = cidre::mach::TimeBaseInfo::new();
        (secs * 1e9 * f64::from(info.denom) / f64::from(info.numer)) as u64
    }

    pub async fn run(ctx: &Ctx, mode: Mode, seq: &Sequence) -> anyhow::Result<Verdict> {
        let project = ctx.path("project.cap");
        std::fs::create_dir_all(&project)?;
        let camera = Some(Arc::new(SyntheticCamera::spawn(
            "Cap Chaos Camera",
            seq.camera_info,
        )));
        let mic = Some(Arc::new(SyntheticMicrophone::spawn(
            "Cap Chaos Microphone",
            48_000,
            1,
        )));
        let camera_lock = match camera.as_ref().map(|c| c.lock()) {
            Some(lock) => match lock.await {
                Ok(lock) => Arc::new(lock),
                Err(e) => return Ok(Verdict::rejected(format!("camera lock: {e:#}"))),
            },
            None => unreachable!(),
        };
        let mic_lock = match mic.as_ref().map(|m| m.lock()) {
            Some(lock) => match lock.await {
                Ok(lock) => Arc::new(lock),
                Err(e) => return Ok(Verdict::rejected(format!("mic lock: {e:#}"))),
            },
            None => unreachable!(),
        };
        let handle = match mode {
            Mode::Studio => {
                studio_recording::Actor::builder(project.clone(), ScreenCaptureTarget::CameraOnly)
                    .with_camera_feed(camera_lock.clone())
                    .with_mic_feed(mic_lock.clone())
                    .with_keyboard_capture(false)
                    .build(None)
                    .await
                    .map(Handle::Studio)
            }
            Mode::Instant => {
                instant_recording::Actor::builder(project.clone(), ScreenCaptureTarget::CameraOnly)
                    .with_camera_feed(camera_lock.clone())
                    .with_mic_feed(mic_lock.clone())
                    .build(None)
                    .await
                    .map(Handle::Instant)
            }
        };
        let handle = match handle {
            Ok(h) => h,
            Err(e) => return Ok(Verdict::rejected(format!("build: {e:#}"))),
        };
        let mut camera = camera;
        let mut mic = mic;
        let (mut width, mut height, mut format) = (
            seq.camera_info.width.max(2),
            seq.camera_info.height.max(2),
            Pixel::NV12,
        );
        let start = host_now();
        let mut clock = 0.0f64;
        let mut direction = 1.0f64;
        let mut index = 0u32;
        let mut first_error: Option<String> = None;
        let mut stopped = false;
        for step in &seq.steps {
            let result = match *step {
                Step::Frames(secs) => {
                    let end = clock + secs;
                    while clock < end {
                        tokio::time::sleep(Duration::from_millis(33)).await;
                        let at = if direction > 0.0 {
                            start + ticks(clock)
                        } else {
                            start.saturating_sub(ticks(clock))
                        };
                        if let Some(camera) = &camera
                            && let Some(frame) = camera_frame(width, height, format, index, at)
                        {
                            let _ = camera.try_push_native(frame);
                        }
                        if let Some(mic) = &mic {
                            let samples = vec![0.1f32; 1600];
                            let _ = mic.try_push(
                                &samples,
                                Timestamp::MachAbsoluteTime(MachAbsoluteTimestamp::new(
                                    start + ticks(clock),
                                )),
                            );
                        }
                        clock += 1.0 / 30.0;
                        index += 1;
                    }
                    Ok(())
                }
                Step::Pause => handle.pause().await,
                Step::Resume => handle.resume().await,
                Step::Cancel => handle.cancel().await,
                Step::Stop => {
                    let r = handle.stop().await;
                    stopped |= r.is_ok();
                    r
                }
                Step::StopAndCancel => {
                    let (a, b) = tokio::join!(handle.stop(), handle.cancel());
                    stopped |= a.is_ok();
                    a.and(b)
                }
                Step::StallCamera => {
                    camera = None;
                    Ok(())
                }
                Step::StallMic => {
                    mic = None;
                    Ok(())
                }
                Step::DisconnectCamera => {
                    if let Some(camera) = camera.take() {
                        camera.remove_input().await;
                    }
                    Ok(())
                }
                Step::DisconnectMic => {
                    if let Some(mic) = mic.take() {
                        mic.remove_input().await;
                    }
                    Ok(())
                }
                Step::CameraShape(w, h, f) => {
                    width = w;
                    height = h;
                    format = f;
                    Ok(())
                }
                Step::CameraBackwards => {
                    direction = -1.0;
                    Ok(())
                }
            };
            if let Err(e) = result
                && first_error.is_none()
            {
                first_error = Some(format!("{step:?}: {e:#}"));
            }
        }
        drop(camera);
        drop(mic);
        if !stopped {
            return Ok(Verdict::rejected(
                first_error.unwrap_or_else(|| "never stopped".into()),
            ));
        }
        let verdict = match mode {
            Mode::Studio => {
                let path = project.clone();
                let remux =
                    tokio::task::spawn_blocking(move || RecoveryManager::remux_if_needed(&path))
                        .await?;
                if let Err(e) = remux {
                    return Ok(Verdict::rejected(format!("finalize: {e}")));
                }
                match cap_project::RecordingMeta::load_for_project(&project) {
                    Err(e) => {
                        Verdict::Wrong(format!("stopped cleanly but the meta is unreadable: {e}"))
                    }
                    Ok(meta) => match meta.studio_meta() {
                        None => Verdict::Wrong("stopped cleanly but the meta is not studio".into()),
                        Some(studio) => {
                            let display = match studio {
                                cap_project::StudioRecordingMeta::SingleSegment { segment } => {
                                    segment.display.path.to_path(&project)
                                }
                                cap_project::StudioRecordingMeta::MultipleSegments { inner } => {
                                    match inner.segments.first() {
                                        Some(s) => s.display.path.to_path(&project),
                                        None => {
                                            return Ok(if seq.expect_media {
                                                Verdict::Wrong(
                                                    "stopped cleanly with no segment".into(),
                                                )
                                            } else {
                                                Verdict::Ok("no segment".into())
                                            });
                                        }
                                    }
                                }
                            };
                            media_check::judge_output(&display, seq.expect_media)
                        }
                    },
                }
            }
            Mode::Instant => {
                let content = project.join("content");
                let display = content.join("display");
                let output = content.join("output.mp4");
                if display.is_dir() {
                    let audio = content.join("audio");
                    let out = output.clone();
                    let finalize = tokio::task::spawn_blocking(move || {
                        RecoveryManager::finalize_instant_output(&display, &audio, &out)
                    })
                    .await?;
                    if let Err(e) = finalize {
                        return Ok(Verdict::rejected(format!("finalize: {e}")));
                    }
                }
                media_check::judge_output(&output, seq.expect_media)
            }
        };
        Ok(match (verdict, first_error) {
            (Verdict::Ok(text), Some(err)) => Verdict::Ok(format!("{text}; {err}")),
            (v, _) => v,
        })
    }

    pub fn probes(out: &mut Vec<Probe>) {
        for (mode_name, mode) in [("studio", Mode::Studio), ("instant", Mode::Instant)] {
            for seq in sequences() {
                let name = seq.name;
                let seq = Arc::new(seq);
                let probe = Probe::new(
                    format!("chaos/record/actor/{mode_name}/{name}"),
                    90,
                    move |ctx| ctx.block_on(run(ctx, mode, &seq)),
                );
                let fast = mode == Mode::Studio
                    || matches!(
                        name,
                        "control"
                            | "stop-before-first-frame"
                            | "stop-twice"
                            | "stop-and-cancel-together"
                            | "camera-format-changes"
                    );
                out.push(if fast { probe } else { probe.full() });
            }
        }
    }
}

pub fn probes(out: &mut Vec<Probe>) {
    #[cfg(target_os = "macos")]
    mac::probes(out);
    let _ = out;
}
