//! Crash safety of fragmented Studio recording: the out-of-process muxer
//! against the in-process one, and recovery after the recorder, the muxer or
//! the disk fails.
//!
//! Synthetic marker frames go through the product's Studio display muxers.
//! macOS: the in-process `MacOSFragmentedM4SMuxer` and the out-of-process
//! `OutOfProcessFragmentedM4SMuxer` (a `cap-muxer` child), fed NV12 IOSurface
//! sample buffers like ScreenCaptureKit delivers. Linux and Windows: the
//! shared `SegmentedVideoEncoder` writer through `ffmpeg::SegmentedVideoMuxer`
//! (the Linux Studio display muxer; on Windows the writer behind
//! `WindowsFragmentedM4SMuxer`, whose Direct3D capture frames cannot be
//! synthesized, so Windows has no out-of-process case here).
//!
//! Every frame handed to the pipeline is logged (index, capture time) line by
//! line, so the truth survives a SIGKILL of the recorder. Recovery is judged
//! against what is physically on disk after the failure: every fragment whose
//! box structure is complete must come back frame for frame at its capture
//! time. Frames lost to a failure must be the newest ones and fit in the
//! fragment being written: one GOP (`GOP_SECS` x fps frames, the encoder's
//! keyframe interval, so the longest a segment can be when frames arrive at
//! the nominal rate) plus the writer's frames still inside the pipeline.

mod common;

use std::{
    collections::BTreeMap,
    io::Write,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    time::{Duration, Instant},
};

use anyhow::{Context, anyhow, bail};
use cap_media_info::{RawVideoFormat, VideoInfo};
use cap_recording::{
    ChannelVideoSource, ChannelVideoSourceConfig, OutputPipeline, recovery::RecoveryManager,
};
use cap_timestamp::{Timestamp, Timestamps};
use cap_verify::{
    fixture::Rng,
    media,
    report::{self, Case, Tier},
    video_code::{self, FrameMarker, StreamKind},
};
use tracing_subscriber::fmt::writer::MakeWriterExt;

const FPS: u32 = 30;
const WIDTH: u32 = 640;
const HEIGHT: u32 = 360;
/// `DEFAULT_KEYFRAME_INTERVAL_SECS` in crates/enc-ffmpeg/src/video/h264.rs:
/// the encoder emits a keyframe every `GOP_SECS * fps` frames and both DASH
/// writers cut a segment only at a keyframe.
const GOP_SECS: f64 = 2.0;
const GOP: u32 = (GOP_SECS as u32) * FPS;
/// Frames that can still be inside the pipeline when the process dies: the
/// one the encoder holds back to stamp real durations (segmented_stream.rs
/// `queue_frame`), the one being encoded, and the one in the muxer channel.
/// The emitter runs at the nominal rate on an idle encoder, so the channel
/// holds at most one frame at a time.
const IN_FLIGHT: u32 = 3;

fn recorder_in_flight(arm: Arm, encoder: &str) -> u32 {
    // VideoToolbox can retain four frames before emitting their packets,
    // in addition to the duration holder, active encode and channel slots.
    // The OOP writer drains its received packets after recorder EOF.
    IN_FLIGHT + u32::from(encoder == "h264_videotoolbox" && arm == Arm::InProcess) * 4
}
fn selected_encoder(log: &str) -> Option<&str> {
    log.lines().find_map(|line| {
        if line.contains("Selected hardware H264 encoder with zero-copy VideoToolbox input") {
            Some("h264_videotoolbox")
        } else {
            [
                "Selected hardware H264 encoder ",
                "Using SOFTWARE H264 encoder (high CPU usage expected) ",
                "Using SOFTWARE encoder for high throughput (hardware cannot keep up at this resolution/fps) ",
            ]
            .into_iter()
            .find_map(|message| line.split_once(message))
            .and_then(|(_, fields)| {
                fields
                    .split_whitespace()
                    .find_map(|field| field.strip_prefix("encoder="))
            })
        }
    })
}

/// Recorded length of every case.
const SECONDS: f64 = 8.0;
/// Truth timestamps vs presentation times: the encoder time base and the
/// container round to at most 1/90000 s; half a millisecond is far below the
/// 33 ms frame period and above any rounding.
const PTS_TOLERANCE: f64 = 0.0005;
const CHILD_ENV: &str = "CAP_VERIFY_CRASH_CHILD";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Arm {
    /// The default in-process writer.
    InProcess,
    /// `out_of_process_muxer` on (macOS only here).
    OutOfProcess,
}

impl Arm {
    fn label(self) -> &'static str {
        match self {
            Arm::InProcess => "inproc",
            Arm::OutOfProcess => "oop",
        }
    }

    fn parse(text: &str) -> Option<Self> {
        match text {
            "inproc" => Some(Arm::InProcess),
            "oop" => Some(Arm::OutOfProcess),
            _ => None,
        }
    }
}

fn arms() -> Vec<Arm> {
    if cfg!(target_os = "macos") {
        vec![Arm::InProcess, Arm::OutOfProcess]
    } else {
        vec![Arm::InProcess]
    }
}

/// One frame the emitter handed to the pipeline.
#[derive(Clone, Copy, Debug)]
struct Handed {
    index: u32,
    /// Seconds after the first handed frame.
    secs: f64,
}

/// What a recording run left behind: the truth and the display directory.
struct Run {
    handed: Vec<Handed>,
    display: PathBuf,
}

#[cfg(target_os = "macos")]
mod source {
    use super::*;
    use cap_recording::{
        MacOSFragmentedM4SMuxer, MacOSFragmentedM4SMuxerConfig, OutOfProcessFragmentedM4SMuxer,
        OutOfProcessFragmentedM4SMuxerConfig, screen_capture,
    };
    use cidre::cm;

    pub type Frame = screen_capture::VideoFrame;

    pub fn info() -> VideoInfo {
        VideoInfo::from_raw(RawVideoFormat::Nv12, WIDTH, HEIGHT, FPS)
    }

    pub type Picture = cidre::arc::R<cm::SampleBuf>;

    /// Renders ahead of time so emission keeps the nominal rate.
    pub fn picture(index: u32) -> anyhow::Result<Picture> {
        picture_sized(index, WIDTH, HEIGHT, FPS)
    }

    pub fn picture_sized(index: u32, width: u32, height: u32, fps: u32) -> anyhow::Result<Picture> {
        let rgba = video_code::marker_rgba(
            FrameMarker::new(StreamKind::Screen, 0, index),
            width as usize,
            height as usize,
        );
        let buf = cap_verify::fixture_avf::pixel_buffer(width as usize, height as usize, &rgba)?;
        let format_desc = cm::VideoFormatDesc::with_image_buf(&buf)
            .map_err(|e| anyhow!("format description: {e:?}"))?;
        let timing = cm::SampleTimingInfo {
            duration: cm::Time::new(1, fps as i32),
            pts: cm::Time::new(i64::from(index), fps as i32),
            dts: cm::Time::invalid(),
        };
        cm::SampleBuf::with_image_buf(&buf, true, None, std::ptr::null(), &format_desc, &timing)
            .map_err(|e| anyhow!("sample buffer: {e:?}"))
    }

    pub fn frame(picture: Picture, at: Instant) -> Frame {
        screen_capture::VideoFrame {
            sample_buf: picture,
            timestamp: Timestamp::Instant(at),
        }
    }

    pub async fn pipeline(
        display: &Path,
        arm: Arm,
        rx: flume::Receiver<Frame>,
        timestamps: Timestamps,
    ) -> anyhow::Result<OutputPipeline> {
        pipeline_with(display, arm, rx, timestamps, info()).await
    }

    pub async fn pipeline_with(
        display: &Path,
        arm: Arm,
        rx: flume::Receiver<Frame>,
        timestamps: Timestamps,
        info: VideoInfo,
    ) -> anyhow::Result<OutputPipeline> {
        let builder = OutputPipeline::builder(display.to_path_buf())
            .with_video::<ChannelVideoSource<Frame>>(ChannelVideoSourceConfig::new(info, rx))
            .with_timestamps(timestamps);
        match arm {
            Arm::InProcess => {
                builder
                    .build::<ObservedMuxer<MacOSFragmentedM4SMuxer>>(
                        MacOSFragmentedM4SMuxerConfig {
                            timed_fragments: true,
                            ..Default::default()
                        },
                    )
                    .await
            }
            Arm::OutOfProcess => {
                builder
                    .build::<ObservedMuxer<OutOfProcessFragmentedM4SMuxer>>(
                        OutOfProcessFragmentedM4SMuxerConfig::default(),
                    )
                    .await
            }
        }
    }
}

#[cfg(not(target_os = "macos"))]
mod source {
    use super::*;
    use cap_recording::ffmpeg::{FFmpegVideoFrame, SegmentedVideoMuxer, SegmentedVideoMuxerConfig};

    pub type Frame = FFmpegVideoFrame;

    pub fn info() -> VideoInfo {
        VideoInfo::from_raw(RawVideoFormat::Bgra, WIDTH, HEIGHT, FPS)
    }

    pub type Picture = ffmpeg::frame::Video;

    /// Renders ahead of time so emission keeps the nominal rate.
    pub fn picture(index: u32) -> anyhow::Result<Picture> {
        let mut frame = ffmpeg::frame::Video::new(ffmpeg::format::Pixel::BGRA, WIDTH, HEIGHT);
        let stride = frame.stride(0);
        video_code::draw_marker(
            FrameMarker::new(StreamKind::Screen, 0, index),
            frame.data_mut(0),
            WIDTH as usize,
            HEIGHT as usize,
            stride,
            video_code::PixelOrder::Bgra,
        );
        Ok(frame)
    }

    pub fn frame(picture: Picture, at: Instant) -> Frame {
        FFmpegVideoFrame {
            inner: picture,
            timestamp: Timestamp::Instant(at),
        }
    }

    pub async fn pipeline(
        display: &Path,
        arm: Arm,
        rx: flume::Receiver<Frame>,
        timestamps: Timestamps,
    ) -> anyhow::Result<OutputPipeline> {
        anyhow::ensure!(arm == Arm::InProcess, "no out-of-process muxer here");
        OutputPipeline::builder(display.to_path_buf())
            .with_video::<ChannelVideoSource<Frame>>(ChannelVideoSourceConfig::new(info(), rx))
            .with_timestamps(timestamps)
            // The Studio display config (capture_pipeline.rs, X11Capture):
            // 2 s segments.
            .build::<ObservedMuxer<SegmentedVideoMuxer>>(SegmentedVideoMuxerConfig {
                timed_fragments: true,
                segment_duration: Duration::from_secs(2),
                ..Default::default()
            })
            .await
    }
}

struct ObservedMuxer<M> {
    inner: M,
    output_path: PathBuf,
}

impl<M: cap_recording::Muxer> cap_recording::Muxer for ObservedMuxer<M>
where
    M::Config: Send,
{
    type Config = M::Config;

    async fn setup(
        config: Self::Config,
        output_path: PathBuf,
        video_config: Option<VideoInfo>,
        audio_config: Option<cap_media_info::AudioInfo>,
        pause_flag: std::sync::Arc<std::sync::atomic::AtomicBool>,
        tasks: &mut cap_recording::TaskPool,
    ) -> anyhow::Result<Self> {
        let inner = M::setup(
            config,
            output_path.clone(),
            video_config,
            audio_config,
            pause_flag,
            tasks,
        )
        .await?;
        Ok(Self { inner, output_path })
    }

    fn stop(&mut self) {
        self.inner.stop();
        std::fs::write(self.output_path.join("mux-video-stopped"), b"stopped")
            .expect("write EOF acknowledgement");
    }

    fn finish(&mut self, timestamp: Duration) -> anyhow::Result<anyhow::Result<()>> {
        finalization_barrier(&self.output_path)?;
        self.inner.finish(timestamp)
    }

    fn set_health_sender(&mut self, tx: cap_recording::HealthSender) {
        self.inner.set_health_sender(tx);
    }
}

impl<M: cap_recording::VideoMuxer<VideoFrame = source::Frame>> cap_recording::VideoMuxer
    for ObservedMuxer<M>
where
    M::Config: Send,
{
    type VideoFrame = source::Frame;

    fn send_video_frame(
        &mut self,
        frame: Self::VideoFrame,
        timestamp: Duration,
    ) -> anyhow::Result<()> {
        self.inner.send_video_frame(frame, timestamp)
    }
}

impl<M: cap_recording::AudioMuxer> cap_recording::AudioMuxer for ObservedMuxer<M>
where
    M::Config: Send,
{
    fn send_audio_frame(
        &mut self,
        frame: cap_recording::AudioFrame,
        timestamp: Duration,
    ) -> anyhow::Result<()> {
        self.inner.send_audio_frame(frame, timestamp)
    }
}

fn finalization_barrier(display: &Path) -> anyhow::Result<()> {
    let hold = display.join("hold-finalization");
    if !hold.exists() {
        return Ok(());
    }
    std::fs::write(display.join("finalization-entered"), b"entered")?;
    let deadline = Instant::now() + Duration::from_secs(45);
    while hold.exists() {
        anyhow::ensure!(Instant::now() < deadline, "finalization barrier timed out");
        std::thread::sleep(Duration::from_millis(2));
    }
    Ok(())
}

/// Line-per-event truth log that a SIGKILL cannot lose (no buffering).
struct TruthLog(Option<std::fs::File>);

impl TruthLog {
    fn line(&mut self, text: &str) {
        if let Some(file) = &mut self.0 {
            let _ = file.write_all(format!("{text}\n").as_bytes());
        }
    }
}

/// Hooks a case runs while the recorder is live.
#[derive(Default)]
struct Live {
    /// Called with every handed index (after it was handed).
    on_frame: Option<Box<dyn FnMut(u32) + Send>>,
}

/// Records `seconds` of marker frames into `display` and stops like the
/// recorder (`OutputPipeline::stop`).
/// Every `step`-th slot of the nominal rate carries a frame (1 = steady; more
/// is a mostly static screen, where ScreenCaptureKit delivers only changes).
async fn record(
    display: &Path,
    arm: Arm,
    seconds: f64,
    step: u32,
    truth: Option<&Path>,
    mut live: Live,
) -> anyhow::Result<Run> {
    std::fs::create_dir_all(display)?;
    let mut log = TruthLog(match truth {
        Some(path) => Some(std::fs::File::create(path)?),
        None => None,
    });
    let count = (seconds * f64::from(FPS)) as u32;
    let slots: Vec<u32> = (0..count).step_by(step.max(1) as usize).collect();
    let mut pictures = slots
        .iter()
        .copied()
        .map(source::picture)
        .collect::<anyhow::Result<Vec<_>>>()?
        .into_iter();
    let timestamps = Timestamps::now();
    let (tx, rx) = flume::bounded::<source::Frame>(8);
    let mut pipeline = source::pipeline(display, arm, rx, timestamps).await?;
    let mut health = pipeline.take_health_rx();
    let base = Instant::now() + Duration::from_millis(50);
    let mut handed = Vec::new();
    for index in slots {
        let at = base + Duration::from_secs_f64(f64::from(index) / f64::from(FPS));
        tokio::time::sleep_until(at.into()).await;
        let picture = pictures.next().expect("rendered");
        let frame = source::frame(picture, at);
        tx.send_async(frame)
            .await
            .map_err(|_| anyhow!("pipeline stopped taking frames at {index}"))?;
        let secs = f64::from(index) / f64::from(FPS);
        handed.push(Handed { index, secs });
        log.line(&format!("f {index} {secs:.6}"));
        if let Some(hook) = live.on_frame.as_mut() {
            hook(index);
        }
    }
    tokio::time::sleep(Duration::from_millis(200)).await;
    drop(tx);
    tokio::time::timeout(Duration::from_secs(5), async {
        while !display.join("mux-video-stopped").exists() {
            tokio::time::sleep(Duration::from_millis(1)).await;
        }
    })
    .await
    .context("waiting for mux-video EOF")?;
    log.line("stop");
    let finished = pipeline.stop().await;
    if let Some(health) = health.as_mut() {
        while let Ok(event) = health.try_recv() {
            log.line(&format!("health {event:?}"));
        }
    }
    finished.map_err(|e| anyhow!("stop: {e:#}"))?;
    log.line("done");
    Ok(Run {
        handed,
        display: display.to_path_buf(),
    })
}

fn read_truth(path: &Path) -> anyhow::Result<(Vec<Handed>, bool, Vec<String>)> {
    let text = std::fs::read_to_string(path).with_context(|| format!("read {path:?}"))?;
    let mut handed = Vec::new();
    let mut stopped = false;
    let mut health = Vec::new();
    for line in text.lines() {
        let mut parts = line.split(' ');
        match parts.next() {
            Some("f") => {
                let (Some(index), Some(secs)) = (parts.next(), parts.next()) else {
                    continue;
                };
                // A kill can cut the last line short.
                if let (Ok(index), Ok(secs)) = (index.parse(), secs.parse()) {
                    if line.len() > 2 && secs_complete(line) {
                        handed.push(Handed { index, secs });
                    }
                }
            }
            Some("stop") => stopped = true,
            Some("health") => health.push(line[7..].to_string()),
            _ => {}
        }
    }
    Ok((handed, stopped, health))
}

/// The writer prints 6 decimals; a shorter field was cut by the kill.
fn secs_complete(line: &str) -> bool {
    line.rsplit(' ')
        .next()
        .and_then(|s| s.split('.').nth(1))
        .is_some_and(|d| d.len() == 6)
}

/// Runs only as a child of `crash_safety` (`CAP_VERIFY_CRASH_CHILD` set):
/// records into the given directory until it is killed or finishes.
#[test]
fn crash_child_recorder() {
    let Ok(spec) = std::env::var(CHILD_ENV) else {
        return;
    };
    let fields: BTreeMap<&str, &str> = spec
        .split(';')
        .filter_map(|kv| kv.split_once('='))
        .collect();
    let arm = Arm::parse(fields["arm"]).expect("arm");
    let display = PathBuf::from(fields["display"]);
    let truth = PathBuf::from(fields["truth"]);
    let seconds: f64 = fields["seconds"].parse().expect("seconds");
    let step: u32 = fields["step"].parse().expect("step");
    let encoder_log = std::fs::File::create(truth.with_extension("encoder.log"))
        .expect("create recorder encoder log");
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::new(std::env::var("CAP_VERIFY_LOG").unwrap_or_default())
                .add_directive(
                    "cap_enc_ffmpeg::video::h264=info"
                        .parse()
                        .expect("encoder filter"),
                ),
        )
        .without_time()
        .with_level(false)
        .with_target(false)
        .with_ansi(false)
        .with_writer(encoder_log.and(std::io::stderr))
        .try_init()
        .expect("capture recorder encoder selection");
    common::init();
    if arm == Arm::OutOfProcess {
        cap_recording::oop_muxer::resolve_muxer_binary().expect("child recorder: cap-muxer binary");
    }
    let rt = common::runtime();
    rt.block_on(record(
        &display,
        arm,
        seconds,
        step,
        Some(&truth),
        Live::default(),
    ))
    .expect("child recording");
}

struct ChildRecorder {
    child: Child,
    truth: PathBuf,
}

impl ChildRecorder {
    fn spawn(
        display: &Path,
        truth: &Path,
        arm: Arm,
        seconds: f64,
        step: u32,
    ) -> anyhow::Result<Self> {
        let exe = std::env::current_exe()?;
        let mut command = Command::new(exe);
        if let Ok(muxer) = cap_recording::oop_muxer::resolve_muxer_binary() {
            command.env(cap_recording::oop_muxer::ENV_BIN_PATH, muxer);
        }
        let child = command
            .args([
                "crash_child_recorder",
                "--exact",
                "--nocapture",
                "--test-threads=1",
            ])
            .env(
                CHILD_ENV,
                format!(
                    "arm={};display={};truth={};seconds={seconds};step={step}",
                    arm.label(),
                    display.display(),
                    truth.display()
                ),
            )
            .stdout(Stdio::null())
            .stderr(Stdio::inherit())
            .spawn()?;
        Ok(Self {
            child,
            truth: truth.to_path_buf(),
        })
    }

    /// Polls the truth log until `ready` holds (or the child exits).
    fn wait_until(
        &mut self,
        timeout: Duration,
        mut ready: impl FnMut(&[Handed], bool) -> bool,
    ) -> anyhow::Result<()> {
        let deadline = Instant::now() + timeout;
        loop {
            if self.truth.exists() {
                let (handed, stopped, _) = read_truth(&self.truth)?;
                if ready(&handed, stopped) {
                    return Ok(());
                }
            }
            if let Some(status) = self.child.try_wait()? {
                bail!("child recorder exited early: {status}");
            }
            if Instant::now() > deadline {
                bail!("child recorder did not reach the kill point in {timeout:?}");
            }
            std::thread::sleep(Duration::from_millis(2));
        }
    }

    /// SIGKILL (TerminateProcess on Windows); returns the cap-muxer child
    /// pids it left behind.
    fn kill(mut self) -> anyhow::Result<Vec<u32>> {
        let orphans = muxer_children(self.child.id());
        self.child.kill()?;
        self.child.wait()?;
        Ok(orphans)
    }
}

impl Drop for ChildRecorder {
    fn drop(&mut self) {
        if !matches!(self.child.try_wait(), Ok(Some(_))) {
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
    }
}

/// `cap-muxer` processes whose parent is `pid`.
fn muxer_children(pid: u32) -> Vec<u32> {
    if cfg!(windows) {
        return Vec::new();
    }
    let Ok(out) = Command::new("pgrep")
        .args(["-P", &pid.to_string(), "-x", "cap-muxer"])
        .output()
    else {
        return Vec::new();
    };
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter_map(|l| l.trim().parse().ok())
        .collect()
}

fn alive(pid: u32) -> bool {
    Command::new("kill")
        .args(["-0", &pid.to_string()])
        .stderr(Stdio::null())
        .status()
        .is_ok_and(|s| s.success())
}

fn signal(pid: u32, sig: &str) -> anyhow::Result<()> {
    let status = Command::new("kill")
        .args([&format!("-{sig}"), &pid.to_string()])
        .status()?;
    anyhow::ensure!(status.success(), "kill -{sig} {pid} failed");
    Ok(())
}

/// After a recorder crash the orphaned cap-muxer sees EOF and finishes its
/// open segment; recovery happens on the next launch, after it exited.
fn wait_for_exit(pids: &[u32], case: &mut Case) {
    let started = Instant::now();
    for &pid in pids {
        while alive(pid) && started.elapsed() < Duration::from_secs(20) {
            std::thread::sleep(Duration::from_millis(20));
        }
        if alive(pid) {
            case.problem(
                "orphan",
                format!("cap-muxer {pid} still running 20 s after the recorder died"),
            );
        }
    }
    if !pids.is_empty() {
        case.note(format!(
            "orphaned cap-muxer exited {:.2}s after the kill",
            started.elapsed().as_secs_f64()
        ));
    }
}

/// Top-level ISO BMFF boxes span the file exactly and include moof + mdat:
/// the writer finished this fragment (independent of recovery.rs).
fn fragment_complete(path: &Path) -> bool {
    let Ok(data) = std::fs::read(path) else {
        return false;
    };
    let mut at = 0usize;
    let (mut moof, mut mdat) = (false, false);
    while at + 8 <= data.len() {
        let size32 = u32::from_be_bytes(data[at..at + 4].try_into().unwrap()) as usize;
        let kind = &data[at + 4..at + 8];
        let size = match size32 {
            0 => return false,
            1 => {
                if at + 16 > data.len() {
                    return false;
                }
                u64::from_be_bytes(data[at + 8..at + 16].try_into().unwrap()) as usize
            }
            n => n,
        };
        if size < 8 {
            return false;
        }
        moof |= kind == b"moof";
        mdat |= kind == b"mdat";
        at += size;
    }
    at == data.len() && moof && mdat
}

// A segment can contain several moof/mdat fragments and end mid-write.
// This oracle deliberately does not use the recovery parser being tested.
fn complete_fragment_ends(data: &[u8]) -> Vec<usize> {
    let mut ends = Vec::new();
    let mut at = 0usize;
    let mut pending_moof = false;
    while let Some(header) = data.get(at..).and_then(|tail| tail.get(..8)) {
        let size32 = u32::from_be_bytes(header[..4].try_into().unwrap());
        let (size, header_len) = match size32 {
            0 => break,
            1 => {
                let Some(extended) = data.get(at..).and_then(|tail| tail.get(8..16)) else {
                    break;
                };
                let Ok(size) = usize::try_from(u64::from_be_bytes(extended.try_into().unwrap()))
                else {
                    break;
                };
                (size, 16)
            }
            size => (size as usize, 8),
        };
        let Some(end) = at.checked_add(size).filter(|end| *end <= data.len()) else {
            break;
        };
        if size < header_len {
            break;
        }
        match &header[4..8] {
            b"moof" if pending_moof => break,
            b"moof" => pending_moof = true,
            b"mdat" if pending_moof => {
                ends.push(end);
                pending_moof = false;
            }
            b"mdat" => break,
            _ => {}
        }
        at = end;
    }
    ends
}

fn segment_index(name: &str) -> Option<u32> {
    name.strip_prefix("segment_")?
        .trim_end_matches(".tmp")
        .strip_suffix(".m4s")?
        .parse()
        .ok()
}

/// Segments with at least one complete on-disk fragment, including a
/// complete prefix of an interrupted `.m4s.tmp`, in index order.
fn complete_fragments(dir: &Path) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut found: BTreeMap<u32, PathBuf> = BTreeMap::new();
    for entry in entries.flatten() {
        let path = entry.path();
        let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        let Some(index) = segment_index(name) else {
            continue;
        };
        if std::fs::read(&path)
            .map(|data| complete_fragment_ends(&data).is_empty())
            .unwrap_or(true)
        {
            continue;
        }
        // Prefer the renamed file when both exist.
        if name.ends_with(".tmp") && found.contains_key(&index) {
            continue;
        }
        found.insert(index, path);
    }
    found.into_values().collect()
}

/// Writer directories: the display directory and every `respawn-N` beside
/// it (out-of-process muxer restarts), in order.
fn writer_dirs(display: &Path) -> Vec<PathBuf> {
    let mut dirs = vec![display.to_path_buf()];
    let mut respawns: Vec<(u32, PathBuf)> = std::fs::read_dir(display)
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().into_owned();
            let n = name.strip_prefix("respawn-")?.parse().ok()?;
            Some((n, e.path()))
        })
        .collect();
    respawns.sort();
    dirs.extend(respawns.into_iter().map(|(_, p)| p));
    dirs
}

/// Decoded (marker index, presentation seconds) of a set of fragments,
/// joined with their init segment into a temporary file.
fn decode_fragments(
    dir: &Path,
    fragments: &[PathBuf],
    scratch: &Path,
) -> anyhow::Result<Vec<(u32, f64)>> {
    if fragments.is_empty() {
        return Ok(Vec::new());
    }
    let mut joined = std::fs::read(dir.join("init.mp4")).context("init.mp4")?;
    for fragment in fragments {
        let data = std::fs::read(fragment)?;
        if let Some(&end) = complete_fragment_ends(&data).last() {
            joined.extend_from_slice(&data[..end]);
        }
    }
    let path = scratch.join(format!(
        "joined-{}.mp4",
        dir.file_name().unwrap_or_default().to_string_lossy()
    ));
    std::fs::write(&path, joined)?;
    let decoded = decode_markers(&path);
    let _ = std::fs::remove_file(&path);
    decoded
}

fn decode_markers(path: &Path) -> anyhow::Result<Vec<(u32, f64)>> {
    let mut out = Vec::new();
    let mut unreadable = 0usize;
    media::decode_video(path, |picture| {
        let readout = video_code::read_frame(&picture.view());
        match readout.get(StreamKind::Screen).marker() {
            Some(marker) => out.push((marker.index, picture.pts_secs)),
            None => unreadable += 1,
        }
    })?;
    anyhow::ensure!(
        unreadable == 0,
        "{unreadable} pictures without a readable marker"
    );
    Ok(out)
}

/// The frames of every physically complete fragment, per fragment, writer
/// directories in order.
fn fragments_on_disk(display: &Path, scratch: &Path) -> anyhow::Result<Vec<Vec<(u32, f64)>>> {
    let mut out = Vec::new();
    for dir in writer_dirs(display) {
        for fragment in complete_fragments(&dir) {
            let data = std::fs::read(&fragment)?;
            let init = std::fs::read(dir.join("init.mp4"))?;
            let path = scratch.join("fragment-prefix.mp4");
            let mut previous = Vec::new();
            for end in complete_fragment_ends(&data) {
                std::fs::write(&path, [&init[..], &data[..end]].concat())?;
                let frames = decode_markers(&path)?;
                anyhow::ensure!(
                    frames.starts_with(&previous),
                    "decoding a longer fragment prefix changed earlier frames"
                );
                out.push(frames[previous.len()..].to_vec());
                previous = frames;
            }
            let _ = std::fs::remove_file(&path);
        }
    }
    Ok(out)
}

fn pending_fragment_frames(
    display: &Path,
    scratch: &Path,
) -> anyhow::Result<std::collections::BTreeSet<u32>> {
    let mut frames = std::collections::BTreeSet::new();
    for dir in writer_dirs(display) {
        let Ok(bytes) = std::fs::read(dir.join("manifest.json")) else {
            continue;
        };
        let manifest: serde_json::Value = serde_json::from_slice(&bytes)?;
        let entries = manifest
            .get("segments")
            .or_else(|| manifest.get("fragments"));
        let Some(entries) = entries.and_then(serde_json::Value::as_array) else {
            continue;
        };
        for fragment in complete_fragments(&dir) {
            let Some(index) = fragment
                .file_name()
                .and_then(|n| n.to_str())
                .and_then(segment_index)
            else {
                continue;
            };
            let pending = entries.iter().any(|entry| {
                entry
                    .get("is_complete")
                    .and_then(serde_json::Value::as_bool)
                    == Some(false)
                    && entry
                        .get("path")
                        .and_then(serde_json::Value::as_str)
                        .and_then(|path| Path::new(path).file_name())
                        .and_then(|name| name.to_str())
                        .and_then(segment_index)
                        == Some(index)
            });
            if pending {
                frames.extend(
                    decode_fragments(&dir, &[fragment], scratch)?
                        .into_iter()
                        .map(|frame| frame.0),
                );
            }
        }
    }
    Ok(frames)
}

/// Every frame inside the physically complete fragments, in order.
fn on_disk(display: &Path, scratch: &Path) -> anyhow::Result<Vec<(u32, f64)>> {
    Ok(fragments_on_disk(display, scratch)?.concat())
}

/// A timed fragment covers capture time from its first frame to the first
/// frame of the next one, and the writer must flush a new one once
/// `GOP_SECS` have passed: the span may exceed `GOP_SECS` only by the
/// interval before the frame that closed it.
fn check_fragment_spans(case: &mut Case, fragments: &[Vec<(u32, f64)>], handed: &[Handed]) {
    let time: BTreeMap<u32, f64> = handed.iter().map(|h| (h.index, h.secs)).collect();
    let next_after = |index: u32| handed.iter().find(|h| h.index > index).map(|h| h.secs);
    let mut worst = 0.0f64;
    for fragment in fragments {
        let (Some(first), Some(last)) = (fragment.first(), fragment.last()) else {
            continue;
        };
        let (Some(&start), Some(&end)) = (time.get(&first.0), time.get(&last.0)) else {
            continue;
        };
        let Some(next) = next_after(last.0) else {
            continue;
        };
        let span = next - start;
        worst = worst.max(span);
        if span > GOP_SECS + (next - end) + 1e-6 {
            case.problem(
                "fragment-span",
                format!(
                    "fragment of frames {}..={} covers {span:.2}s of capture, more than {GOP_SECS}s plus the {:.2}s before the frame that closed it",
                    first.0,
                    last.0,
                    next - end
                ),
            );
        }
    }
    case.note(format!(
        "longest complete fragment covers {worst:.2}s of capture"
    ));
}

/// Out-of-process only: after the recorder died, the orphaned cap-muxer
/// sees EOF and must finish the fragment it had open (nothing it received
/// may be lost).
fn check_open_fragment(case: &mut Case, display: &Path) {
    for dir in writer_dirs(display) {
        for entry in std::fs::read_dir(&dir).into_iter().flatten().flatten() {
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.starts_with("segment_")
                && name.ends_with(".m4s.tmp")
                && !fragment_complete(&path)
            {
                let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
                case.problem(
                    "open-fragment-lost",
                    format!(
                        "the orphaned cap-muxer left {name} incomplete ({size} bytes): the packets it had received are lost"
                    ),
                );
            }
        }
    }
}

/// The recovered display: the app's display finalization
/// (`RecoveryManager::finalize_to_progressive_mp4`, the same call for a clean
/// stop and for crash recovery).
fn finalize(display: &Path, out: &Path) -> anyhow::Result<Vec<(u32, f64)>> {
    RecoveryManager::finalize_to_progressive_mp4(display, out)
        .map_err(|e| anyhow!("finalize: {e}"))?;
    decode_markers(out)
}

/// Checks `frames` (decoded index, pts) against the truth: no duplicates,
/// increasing indices, each frame at its capture time relative to the first
/// recovered frame. Returns the recovered index set.
fn check_timeline(case: &mut Case, label: &str, frames: &[(u32, f64)], handed: &[Handed]) {
    let truth: BTreeMap<u32, f64> = handed.iter().map(|h| (h.index, h.secs)).collect();
    let Some(&(first_index, first_pts)) = frames.first() else {
        case.problem("missing", format!("{label}: no frames"));
        return;
    };
    let Some(&first_truth) = truth.get(&first_index) else {
        case.problem(
            "unexpected",
            format!("{label}: frame {first_index} was never handed"),
        );
        return;
    };
    let mut previous: Option<u32> = None;
    let mut worst = (0.0f64, 0u32);
    let mut off = Vec::new();
    for &(index, pts) in frames {
        if let Some(p) = previous
            && index <= p
        {
            case.problem(
                "order",
                format!("{label}: frame {index} after {p} (repeat or reorder)"),
            );
        }
        previous = Some(index);
        let Some(&t) = truth.get(&index) else {
            case.problem(
                "unexpected",
                format!("{label}: frame {index} was never handed"),
            );
            continue;
        };
        let error = (pts - first_pts) - (t - first_truth);
        if error.abs() > worst.0.abs() {
            worst = (error, index);
        }
        if error.abs() > PTS_TOLERANCE {
            off.push(index);
        }
    }
    if !off.is_empty() {
        case.problem(
            "timestamps",
            format!(
                "{label}: {} frames off their capture time by more than {:.1} ms, worst {:+.1} ms at frame {} (first {:?})",
                off.len(),
                PTS_TOLERANCE * 1e3,
                worst.0 * 1e3,
                worst.1,
                &off[..off.len().min(5)]
            ),
        );
    }
    case.note(format!(
        "{label}: {} frames {}..={}, worst pts error {:+.2} ms",
        frames.len(),
        frames.first().map(|f| f.0).unwrap_or(0),
        frames.last().map(|f| f.0).unwrap_or(0),
        worst.0 * 1e3
    ));
}

/// Recovery keeps everything physically complete and loses at most the
/// fragment being written plus the frames in flight, all at the end.
fn check_recovery(
    case: &mut Case,
    in_flight: u32,
    recovered: &[(u32, f64)],
    physical: &[(u32, f64)],
    handed: &[Handed],
    pending: &std::collections::BTreeSet<u32>,
) {
    check_timeline(case, "recovered", recovered, handed);
    let recovered_set: std::collections::BTreeSet<u32> = recovered.iter().map(|f| f.0).collect();
    let physical_set: std::collections::BTreeSet<u32> = physical.iter().map(|f| f.0).collect();
    let dropped: Vec<u32> = physical_set.difference(&recovered_set).copied().collect();
    if !dropped.is_empty() {
        case.count("dropped-complete", "frames", dropped.len() as f64);
        case.count(
            "dropped-complete",
            "outside-pending",
            dropped
                .iter()
                .filter(|index| !pending.contains(index))
                .count() as f64,
        );
        case.problem(
            "dropped-complete",
            format!(
                "recovery dropped {} frames that were inside complete fragments on disk: {}..={}",
                dropped.len(),
                dropped[0],
                dropped[dropped.len() - 1]
            ),
        );
    }
    let extra: Vec<u32> = recovered_set.difference(&physical_set).copied().collect();
    if !extra.is_empty() {
        case.problem(
            "unexpected",
            format!(
                "recovery produced {} frames that no complete fragment holds: {:?}",
                extra.len(),
                &extra[..extra.len().min(5)]
            ),
        );
    }
    let last_physical = physical.iter().map(|f| f.0).max();
    let lost: Vec<&Handed> = handed
        .iter()
        .filter(|h| last_physical.is_none_or(|p| h.index > p))
        .collect();
    let lost_tail = lost.len() as u32;
    // Capture time the crash lost: from the first lost frame to the last
    // handed one, plus that frame's own period.
    let lost_secs = match (lost.first(), lost.last()) {
        (Some(a), Some(b)) => b.secs - a.secs + 1.0 / f64::from(FPS),
        _ => 0.0,
    };
    let interior: Vec<u32> = handed
        .iter()
        .map(|h| h.index)
        .filter(|i| last_physical.is_some_and(|p| *i < p) && !physical_set.contains(i))
        .collect();
    if !interior.is_empty() {
        case.count("missing", "frames", interior.len() as f64);
        case.problem(
            "missing",
            format!(
                "{} handed frames missing before the last complete fragment's end: {:?}",
                interior.len(),
                &interior[..interior.len().min(5)]
            ),
        );
    }
    let bound = GOP + in_flight;
    // In time: one fragment of capture time, plus the in-flight frames and
    // the frame that closes the fragment at the delivered interval (a static
    // screen delivers far fewer frames than the nominal rate).
    let interval = handed
        .windows(2)
        .map(|w| w[1].secs - w[0].secs)
        .fold(1.0 / f64::from(FPS), f64::max);
    let bound_secs = GOP_SECS + f64::from(in_flight + 1) * interval;
    case.note(format!(
        "handed {} frames, complete on disk up to {:?}, lost tail {lost_tail} frames / {lost_secs:.2}s (bound {bound} frames / {bound_secs:.2}s)",
        handed.len(),
        last_physical
    ));
    if lost_tail > bound {
        case.measure("loss", "frames", f64::from(lost_tail));
        case.problem(
            "loss",
            format!(
                "the crash lost the last {lost_tail} handed frames, more than one fragment ({GOP}) plus {in_flight} in flight"
            ),
        );
    }
    if lost_secs > bound_secs + 1e-6 {
        case.measure("loss-time", "secs", (lost_secs * 100.0).round() / 100.0);
        case.problem(
            "loss-time",
            format!(
                "the crash lost {lost_secs:.2}s of capture, more than one {GOP_SECS}s fragment plus {} frames in flight ({bound_secs:.2}s at the delivered interval)", in_flight + 1
            ),
        );
    }
}

fn scratch_root() -> PathBuf {
    std::env::var_os("CAP_VERIFY_SCRATCH")
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir)
        .join("cap-verify-crash")
}

fn fresh(dir: &Path) -> anyhow::Result<()> {
    let _ = std::fs::remove_dir_all(dir);
    std::fs::create_dir_all(dir)?;
    Ok(())
}

/// Clean recordings through both writers must give the same frames at the
/// same times, all of them, at their capture times.
fn equality(rt: &tokio::runtime::Runtime, case: &mut Case) -> anyhow::Result<()> {
    let scratch = scratch_root().join("equality");
    fresh(&scratch)?;
    let mut results = Vec::new();
    for arm in arms() {
        let display = scratch.join(arm.label()).join("display");
        let run = rt.block_on(record(&display, arm, SECONDS, 1, None, Live::default()))?;
        let out = scratch.join(format!("{}.mp4", arm.label()));
        let frames = finalize(&run.display, &out)?;
        check_timeline(case, arm.label(), &frames, &run.handed);
        let handed: std::collections::BTreeSet<u32> = run.handed.iter().map(|h| h.index).collect();
        let got: std::collections::BTreeSet<u32> = frames.iter().map(|f| f.0).collect();
        let missing: Vec<u32> = handed.difference(&got).copied().collect();
        if !missing.is_empty() {
            case.problem(
                "missing",
                format!(
                    "{}: {} of {} handed frames missing after a clean stop: {:?}",
                    arm.label(),
                    missing.len(),
                    handed.len(),
                    &missing[..missing.len().min(8)]
                ),
            );
        }
        results.push((arm, frames));
    }
    if let [(_, a), (_, b)] = results.as_slice() {
        let differ = a.len() != b.len()
            || a.iter()
                .zip(b)
                .any(|(x, y)| x.0 != y.0 || (x.1 - y.1).abs() > PTS_TOLERANCE);
        if differ {
            case.problem(
                "unequal",
                format!(
                    "in-process and out-of-process outputs differ: {} vs {} frames",
                    a.len(),
                    b.len()
                ),
            );
        } else {
            case.note(format!("in-process == out-of-process: {} frames", a.len()));
        }
    }
    let _ = std::fs::remove_dir_all(&scratch);
    Ok(())
}

/// Static-screen recording: a new picture every `STATIC_STEP` slots (3 per
/// second at 30 fps), killed after `STATIC_KILL_SECS`.
const STATIC_STEP: u32 = 10;
const STATIC_SECONDS: f64 = 14.0;
const STATIC_KILL_SECS: f64 = 11.0;

/// Kills at 2*GOP + k for k = 0..=12 and reports the first k at which the
/// second fragment was complete on disk.
fn writer_latency(arm: Arm, case: &mut Case) -> anyhow::Result<()> {
    let mut first_complete = None;
    for k in 0..=12u32 {
        let name = format!("latency{k}");
        let scratch = scratch_root().join(format!("kill-{}-{name}", arm.label()));
        fresh(&scratch)?;
        let display = scratch.join("display");
        let truth = scratch.join("truth.txt");
        let mut child = ChildRecorder::spawn(&display, &truth, arm, 5.0, 1)?;
        let n = 2 * GOP + k;
        child.wait_until(Duration::from_secs(40), |handed, _| {
            handed.last().is_some_and(|h| h.index >= n)
        })?;
        let orphans = child.kill()?;
        wait_for_exit(&orphans, case);
        let physical = on_disk(&display, &scratch)?;
        let done = physical.iter().any(|f| f.0 == 2 * GOP - 1);
        case.note(format!(
            "kill after frame {n}: fragment 2 complete = {done}"
        ));
        let _ = std::fs::remove_dir_all(&scratch);
        if done && first_complete.is_none() {
            first_complete = Some(k);
        }
    }
    case.note(format!(
        "{}: fragment complete on disk {first_complete:?} frames after its closing keyframe was handed",
        arm.label()
    ));
    Ok(())
}

/// When the recorder process dies. Indices are handed-frame indices.
#[derive(Clone, Copy, Debug)]
enum KillPoint {
    /// After frame N was handed.
    Frame(u32),
    /// Some milliseconds after the recorder started stopping.
    Finalize(u64),
}

fn kill_points(seed: u64) -> Vec<(String, KillPoint)> {
    let mut rng = Rng::new(seed);
    let total = (SECONDS * f64::from(FPS)) as u32;
    let mut points = Vec::new();
    // Mid-fragment, at seeded random frames past the first fragment.
    for k in 0..2 {
        let lo = GOP + 15;
        let index = lo + (rng.next_u64() % u64::from(total - lo - 10)) as u32;
        points.push((format!("random{k}"), KillPoint::Frame(index)));
    }
    // Around the second rollover: the keyframe that closes fragment 2 is
    // frame 2*GOP; the writer renames the segment when the packet after it
    // arrives (the encoder holds one back), and the manifest learns about
    // it on its next 10-frame scan.
    for offset in [0u32, 2, 5] {
        points.push((
            format!("rollover+{offset}"),
            KillPoint::Frame(2 * GOP + offset),
        ));
    }
    for delay in [0u64, 40] {
        points.push((format!("finalize+{delay}ms"), KillPoint::Finalize(delay)));
    }
    points
}

/// Kills a child recorder at `point` and recovers what it left.
/// `seconds`/`step` shape the recording (see `record`).
fn recorder_kill(
    arm: Arm,
    name: &str,
    point: KillPoint,
    seconds: f64,
    step: u32,
    case: &mut Case,
) -> anyhow::Result<()> {
    let scratch = scratch_root().join(format!("kill-{}-{name}", arm.label()));
    fresh(&scratch)?;
    let display = scratch.join("display");
    let truth = scratch.join("truth.txt");
    if matches!(point, KillPoint::Finalize(_)) {
        std::fs::create_dir_all(&display)?;
        std::fs::write(display.join("hold-finalization"), b"hold")?;
    }
    let mut child = ChildRecorder::spawn(&display, &truth, arm, seconds, step)?;
    let timeout = Duration::from_secs_f64(seconds + 30.0);
    match point {
        KillPoint::Frame(n) => child.wait_until(timeout, |handed, _| {
            handed.last().is_some_and(|h| h.index >= n)
        })?,
        KillPoint::Finalize(ms) => {
            child.wait_until(timeout, |_, stopped| {
                stopped && display.join("finalization-entered").exists()
            })?;
            std::thread::sleep(Duration::from_millis(ms));
        }
    }
    let orphans = child.kill()?;
    wait_for_exit(&orphans, case);
    let (handed, stopped, _) = read_truth(&truth)?;
    if matches!(point, KillPoint::Finalize(_)) {
        check_finalize_coverage(case, &display, &truth)?;
    }
    case.note(format!(
        "killed after frame {:?}{}",
        handed.last().map(|h| h.index),
        if stopped { " while stopping" } else { "" }
    ));
    if arm == Arm::OutOfProcess {
        check_open_fragment(case, &display);
    }
    let fragments = fragments_on_disk(&display, &scratch)?;
    // Studio flushes timed fragments; the OOP writer instead drains its
    // keyframe-delimited segment after the recorder exits (#2646, #2644).
    if arm == Arm::InProcess {
        check_fragment_spans(case, &fragments, &handed);
    }
    let physical = fragments.concat();
    let pending = pending_fragment_frames(&display, &scratch)?;
    let recovered = match finalize(&display, &scratch.join("recovered.mp4")) {
        Ok(frames) => frames,
        Err(e) if physical.is_empty() => {
            case.note(format!("nothing complete on disk; recovery: {e:#}"));
            Vec::new()
        }
        Err(e) => return Err(e),
    };
    let in_flight = if arm == Arm::InProcess {
        let log = std::fs::read_to_string(truth.with_extension("encoder.log"))?;
        let encoder =
            selected_encoder(&log).context("recorder did not report its selected encoder")?;
        case.note(format!("recorder encoder: {encoder}"));
        recorder_in_flight(arm, encoder)
    } else {
        IN_FLIGHT
    };
    check_recovery(case, in_flight, &recovered, &physical, &handed, &pending);
    if std::env::var_os("CAP_VERIFY_KEEP").is_none() {
        let _ = std::fs::remove_dir_all(&scratch);
    }
    Ok(())
}

/// Out-of-process only: kill cap-muxer mid-recording. The recording must
/// continue in a respawned muxer, and recovery must keep every complete
/// fragment, at its capture time (a muxer crash must not shift later video
/// against audio).
#[cfg(unix)]
fn muxer_kill(rt: &tokio::runtime::Runtime, case: &mut Case) -> anyhow::Result<()> {
    let scratch = scratch_root().join("muxer-kill");
    fresh(&scratch)?;
    let display = scratch.join("display");
    let kill_at = GOP + GOP / 2;
    let me = std::process::id();
    let killed = std::sync::Arc::new(std::sync::Mutex::new(None::<u32>));
    let killed_hook = killed.clone();
    let live = Live {
        on_frame: Some(Box::new(move |index| {
            if index == kill_at
                && let Some(&pid) = muxer_children(me).first()
            {
                let _ = signal(pid, "KILL");
                *killed_hook.lock().unwrap() = Some(pid);
            }
        })),
    };
    let run = rt.block_on(record(&display, Arm::OutOfProcess, SECONDS, 1, None, live))?;
    let Some(pid) = *killed.lock().unwrap() else {
        bail!("no cap-muxer child to kill at frame {kill_at}");
    };
    case.note(format!("killed cap-muxer {pid} after frame {kill_at}"));
    let respawns = writer_dirs(&display).len() - 1;
    if respawns == 0 {
        case.problem("respawn", "no respawned muxer after the kill");
    }
    let physical = on_disk(&display, &scratch)?;
    let recovered = finalize(&display, &scratch.join("recovered.mp4"))?;
    check_timeline(case, "recovered", &recovered, &run.handed);
    let recovered_set: std::collections::BTreeSet<u32> = recovered.iter().map(|f| f.0).collect();
    let dropped: Vec<u32> = physical
        .iter()
        .map(|f| f.0)
        .filter(|i| !recovered_set.contains(i))
        .collect();
    if !dropped.is_empty() {
        case.count("dropped-complete", "frames", dropped.len() as f64);

        case.problem(
            "dropped-complete",
            format!(
                "finalize dropped {} frames inside complete fragments",
                dropped.len()
            ),
        );
    }
    // Loss: from the last frame the dead muxer finished to the first frame
    // the respawned one kept (the next keyframe): at most the killed
    // fragment plus one GOP until the encoder's next keyframe.
    let indices: Vec<u32> = recovered.iter().map(|f| f.0).collect();
    let gap = indices
        .windows(2)
        .map(|w| w[1] - w[0] - 1)
        .max()
        .unwrap_or(0);
    let last = run.handed.last().map(|h| h.index).unwrap_or(0);
    let tail = last.saturating_sub(*indices.last().unwrap_or(&0));
    case.note(format!(
        "{respawns} respawn(s); recovered {} of {} frames, largest gap {gap} frames, tail {tail}",
        recovered.len(),
        run.handed.len()
    ));
    if gap > 2 * GOP + IN_FLIGHT {
        case.problem(
            "loss",
            format!(
                "a muxer crash lost {gap} consecutive frames ({:.2}s), more than two fragments plus {IN_FLIGHT} in flight",
                f64::from(gap) / f64::from(FPS)
            ),
        );
    }
    if tail > IN_FLIGHT {
        case.problem(
            "loss",
            format!("the respawned muxer lost the last {tail} frames of a clean stop"),
        );
    }
    let _ = std::fs::remove_dir_all(&scratch);
    Ok(())
}

/// CPU seconds and resident memory of a process (`ps`).
#[cfg(target_os = "macos")]
fn process_usage(pid: u32) -> Option<(f64, u64)> {
    let out = Command::new("ps")
        .args(["-o", "time=,rss=", "-p", &pid.to_string()])
        .output()
        .ok()?;
    let text = String::from_utf8_lossy(&out.stdout);
    let mut fields = text.split_whitespace();
    let time = fields.next()?;
    let rss: u64 = fields.next()?.parse().ok()?;
    let mut secs = 0.0;
    for part in time.split(':') {
        secs = secs * 60.0 + part.parse::<f64>().ok()?;
    }
    Some((secs, rss * 1024))
}

/// Total CPU seconds of every VideoToolbox encoder service process (the
/// hardware encoder's host process; shared by every client on the machine).
#[cfg(target_os = "macos")]
fn encoder_service_cpu() -> f64 {
    let Ok(out) = Command::new("pgrep")
        .args(["-x", "VTEncoderXPCService"])
        .output()
    else {
        return 0.0;
    };
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter_map(|l| l.trim().parse().ok())
        .filter_map(process_usage)
        .map(|u| u.0)
        .sum()
}

/// Overhead of the out-of-process muxer at a real Studio size: 1920x1080
/// NV12 at 60 fps for `PERF_SECONDS`, interleaved A/B rounds. Reports CPU
/// seconds of the recorder and of cap-muxer per recorded second and their
/// peak resident memory (measurement only; the default decision reads it).
#[cfg(target_os = "macos")]
const PERF_SECONDS: f64 = 10.0;

#[cfg(target_os = "macos")]
fn overhead(rt: &tokio::runtime::Runtime, case: &mut Case) -> anyhow::Result<()> {
    let (width, height, fps) = (1920u32, 1080u32, 60u32);
    let ring: Vec<source::Picture> = (0..fps)
        .map(|i| source::picture_sized(i, width, height, fps))
        .collect::<anyhow::Result<_>>()?;
    let me = std::process::id();
    let mut results: BTreeMap<&str, Vec<(f64, f64, u64, u64)>> = BTreeMap::new();
    for round in 0..3 {
        let order = if round % 2 == 0 {
            [Arm::InProcess, Arm::OutOfProcess]
        } else {
            [Arm::OutOfProcess, Arm::InProcess]
        };
        for arm in order {
            let scratch = scratch_root().join(format!("perf-{}-{round}", arm.label()));
            fresh(&scratch)?;
            let display = scratch.join("display");
            let ring = ring.clone();
            let sample = rt.block_on(async {
                let info = VideoInfo::from_raw(RawVideoFormat::Nv12, width, height, fps);
                let (tx, rx) = flume::bounded::<source::Frame>(8);
                let pipeline =
                    source::pipeline_with(&display, arm, rx, Timestamps::now(), info).await?;
                let before = process_usage(me).map(|u| u.0).unwrap_or(0.0);
                let service_before = encoder_service_cpu();
                let base = Instant::now() + Duration::from_millis(50);
                let count = (PERF_SECONDS * f64::from(fps)) as u32;
                let (mut peak_self, mut peak_muxer, mut muxer_cpu) = (0u64, 0u64, 0.0f64);
                for index in 0..count {
                    let at = base + Duration::from_secs_f64(f64::from(index) / f64::from(fps));
                    tokio::time::sleep_until(at.into()).await;
                    let picture = ring[(index % fps) as usize].clone();
                    tx.send_async(source::frame(picture, at))
                        .await
                        .map_err(|_| anyhow!("pipeline stopped"))?;
                    if index % (fps / 2) == 0 {
                        if let Some((_, rss)) = process_usage(me) {
                            peak_self = peak_self.max(rss);
                        }
                        for pid in muxer_children(me) {
                            if let Some((cpu, rss)) = process_usage(pid) {
                                peak_muxer = peak_muxer.max(rss);
                                muxer_cpu = muxer_cpu.max(cpu);
                            }
                        }
                    }
                }
                for pid in muxer_children(me) {
                    if let Some((cpu, _)) = process_usage(pid) {
                        muxer_cpu = muxer_cpu.max(cpu);
                    }
                }
                drop(tx);
                pipeline.stop().await.map_err(|e| anyhow!("stop: {e:#}"))?;
                let after = process_usage(me).map(|u| u.0).unwrap_or(0.0);
                let service = (encoder_service_cpu() - service_before).max(0.0);
                anyhow::Ok((
                    (after - before) / PERF_SECONDS,
                    muxer_cpu / PERF_SECONDS + service / PERF_SECONDS,
                    peak_self,
                    peak_muxer,
                ))
            })?;
            case.note(format!(
                "round {round} {}: recorder {:.3} CPU s/s, cap-muxer + VideoToolbox service {:.3} CPU s/s, recorder peak {} MB, cap-muxer peak {} MB",
                arm.label(),
                sample.0,
                sample.1,
                sample.2 / 1_000_000,
                sample.3 / 1_000_000
            ));
            results.entry(arm.label()).or_default().push(sample);
            let _ = std::fs::remove_dir_all(&scratch);
        }
    }
    for (arm, samples) in &results {
        let mut total: Vec<f64> = samples.iter().map(|s| s.0 + s.1).collect();
        total.sort_by(f64::total_cmp);
        case.note(format!(
            "{arm}: median total CPU {:.3} s per recorded second (min {:.3}, max {:.3})",
            total[total.len() / 2],
            total[0],
            total[total.len() - 1]
        ));
    }
    Ok(())
}

#[test]
fn crash_safety() {
    if std::env::var(CHILD_ENV).is_ok() {
        return;
    }
    common::init();
    if cfg!(target_os = "macos") && std::env::var_os("CAP_MUXER_BIN").is_none() {
        // Built next to the test binary by `cargo build -p cap-muxer`.
        if let Some(bin) = std::env::current_exe()
            .ok()
            .and_then(|exe| Some(exe.parent()?.parent()?.join("cap-muxer")))
            .filter(|p| p.exists())
        {
            let _ = cap_recording::oop_muxer::set_muxer_binary_override(bin);
        }
    }
    let rt = common::runtime();
    let tier = report::tier();
    let mut failures = Vec::new();
    let mut settle = |case: Case| {
        for note in &case.notes {
            eprintln!("  note: {note}");
        }
        if let Err(e) = report::settle(case) {
            failures.push(e);
        }
    };

    let oop_ready = cap_recording::oop_muxer::resolve_muxer_binary();

    if cfg!(target_os = "macos") && report::selected("crash/equality") {
        let mut case = Case::new("crash/equality");
        if let Err(e) = &oop_ready {
            case.problem("harness", format!("cap-muxer not found: {e:#}"));
        } else if let Err(e) = equality(&rt, &mut case) {
            case.problem("error", format!("{e:#}"));
        }
        settle(case);
    }

    #[cfg(target_os = "macos")]
    if tier == Tier::Full && report::selected("crash/oop-overhead") {
        let mut case = Case::new("crash/oop-overhead");
        if let Err(e) = overhead(&rt, &mut case) {
            case.problem("error", format!("{e:#}"));
        }
        settle(case);
    }

    #[cfg(unix)]
    if cfg!(target_os = "macos") && report::selected("crash/muxer-kill/oop") {
        let mut case = Case::new("crash/muxer-kill/oop");
        if let Err(e) = muxer_kill(&rt, &mut case) {
            case.problem("error", format!("{e:#}"));
        }
        settle(case);
    }

    let seed: u64 = std::env::var("CAP_VERIFY_CRASH_SEED")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(20261016);
    for arm in arms() {
        for (name, point) in kill_points(seed) {
            let id = format!("crash/recorder-kill/{}/{name}", arm.label());
            if !report::selected(&id) || (tier == Tier::Fast && name.starts_with("random1")) {
                continue;
            }
            let mut case = Case::new(&id);
            case.note(format!("seed {seed}, point {point:?}"));
            if let Err(e) = recorder_kill(arm, &name, point, SECONDS, 1, &mut case) {
                case.problem("error", format!("{e:#}"));
            }
            settle(case);
        }
        // A mostly static screen still has the same crash-loss budget.
        let id = format!("crash/recorder-kill/{}/static-screen", arm.label());
        if report::selected(&id) {
            let mut case = Case::new(&id);
            let kill = (STATIC_KILL_SECS * f64::from(FPS)) as u32;
            if let Err(e) = recorder_kill(
                arm,
                "static",
                KillPoint::Frame(kill),
                STATIC_SECONDS,
                STATIC_STEP,
                &mut case,
            ) {
                case.problem("error", format!("{e:#}"));
            }
            settle(case);
        }
        // Writer latency: how many frames after the keyframe that closes a
        // fragment the fragment is complete on disk (measurement only).
        let id = format!("crash/writer-latency/{}", arm.label());
        if tier == Tier::Full && report::selected(&id) {
            let mut case = Case::new(&id);
            if let Err(e) = writer_latency(arm, &mut case) {
                case.problem("error", format!("{e:#}"));
            }
            settle(case);
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

fn check_finalize_coverage(case: &mut Case, display: &Path, truth: &Path) -> anyhow::Result<()> {
    let done = std::fs::read_to_string(truth)?
        .lines()
        .any(|line| line == "done");
    let entered = display.join("finalization-entered").is_file();
    let held = display.join("hold-finalization").is_file();
    case.note(format!(
        "finalization coverage: entered={entered}, held={held}, done={done}"
    ));
    if done || !entered || !held {
        case.problem("harness", "kill missed the held finalization window");
    }
    Ok(())
}

#[test]
fn finalize_barrier_is_default_off_and_blocks_until_released() {
    let dir = tempfile::tempdir().unwrap();
    finalization_barrier(dir.path()).unwrap();
    assert!(!dir.path().join("finalization-entered").exists());
    std::fs::write(dir.path().join("hold-finalization"), b"hold").unwrap();
    let display = dir.path().to_path_buf();
    let (tx, rx) = std::sync::mpsc::channel();
    let handle = std::thread::spawn(move || {
        finalization_barrier(&display).unwrap();
        tx.send(()).unwrap();
    });
    let deadline = Instant::now() + Duration::from_secs(5);
    while !dir.path().join("finalization-entered").exists() {
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(1));
    }
    assert!(rx.try_recv().is_err());
    std::fs::remove_file(dir.path().join("hold-finalization")).unwrap();
    rx.recv_timeout(Duration::from_secs(5)).unwrap();
    handle.join().unwrap();
}

#[test]
fn finalize_done_is_a_coverage_miss() {
    let dir = tempfile::tempdir().unwrap();
    let truth = dir.path().join("truth.txt");
    std::fs::write(&truth, b"stop\ndone\n").unwrap();
    std::fs::write(dir.path().join("finalization-entered"), b"entered").unwrap();
    std::fs::write(dir.path().join("hold-finalization"), b"hold").unwrap();
    let mut case = Case::new("finalize-coverage-test");
    check_finalize_coverage(&mut case, dir.path(), &truth).unwrap();
    assert!(case.classes.contains("harness"));
}

#[test]
fn duplicate_and_extra_frames_still_fail_after_eof() {
    let handed = vec![
        Handed {
            index: 0,
            secs: 0.0,
        },
        Handed {
            index: 1,
            secs: 1.0 / f64::from(FPS),
        },
    ];
    for frames in [
        vec![(0, 0.0), (1, 1.0 / 30.0), (1, 2.0 / 30.0)],
        vec![(0, 0.0), (1, 1.0 / 30.0), (2, 2.0 / 30.0)],
    ] {
        let mut case = Case::new("eof-mutation-test");
        check_timeline(&mut case, "mutated", &frames, &handed);
        assert!(case.classes.contains("order") || case.classes.contains("unexpected"));
    }
}

#[test]
fn pending_fragment_bound_rejects_other_complete_frame_loss() {
    let handed = vec![
        Handed {
            index: 0,
            secs: 0.0,
        },
        Handed {
            index: 1,
            secs: 1.0 / f64::from(FPS),
        },
    ];
    let physical = vec![(0, 0.0), (1, 1.0 / f64::from(FPS))];
    // The bound the pending-fragment (#2640) entry used: frames inside
    // complete pending fragments only.
    let bound = cap_verify_expect::Bound::from([
        ("count".into(), cap_verify_expect::Range::at(1.0)),
        (
            "frames".into(),
            cap_verify_expect::Range {
                min: 1.0,
                max: 60.0,
            },
        ),
        ("outside-pending".into(), cap_verify_expect::Range::at(0.0)),
    ]);
    for (outside, accepted) in [(0.0, true), (1.0, false)] {
        let metrics = BTreeMap::from([
            ("count".into(), cap_verify_expect::Range::at(1.0)),
            ("frames".into(), cap_verify_expect::Range::at(1.0)),
            (
                "outside-pending".into(),
                cap_verify_expect::Range::at(outside),
            ),
        ]);
        assert_eq!(
            cap_verify_expect::within(&bound, Some(&metrics)).is_ok(),
            accepted
        );
    }
    let mut case = Case::new("pending-fragment-test");
    check_recovery(
        &mut case,
        IN_FLIGHT,
        &physical[..1],
        &physical,
        &handed,
        &std::collections::BTreeSet::from([1]),
    );
    assert!(case.classes.contains("dropped-complete"));
    assert!(!case.classes.contains("loss"));
}

#[test]
fn recorder_encoder_selection_ignores_failed_candidates() {
    let failed = "Hardware H264 encoder failed pre-flight self-test, trying next candidate encoder=h264_videotoolbox";
    assert_eq!(selected_encoder(failed), None);
    for (selection, expected) in [
        (
            "Selected hardware H264 encoder with zero-copy VideoToolbox input width=640",
            "h264_videotoolbox",
        ),
        (
            "Selected hardware H264 encoder encoder=h264_videotoolbox width=640",
            "h264_videotoolbox",
        ),
        (
            "Using SOFTWARE H264 encoder (high CPU usage expected) encoder=libx264 width=640",
            "libx264",
        ),
        (
            "Using SOFTWARE encoder for high throughput (hardware cannot keep up at this resolution/fps) encoder=libx264 width=640",
            "libx264",
        ),
    ] {
        assert_eq!(
            selected_encoder(&format!("{failed}\nrecording: {selection}\n")),
            Some(expected)
        );
    }
}

#[test]
fn recorder_loss_budget_accounts_for_codec_buffering_without_hiding_excess_loss() {
    let physical: Vec<_> = (0..120).map(|i| (i, f64::from(i) / 30.0)).collect();
    for arm in [Arm::InProcess, Arm::OutOfProcess] {
        for encoder in ["libx264", "h264_videotoolbox"] {
            for lost in [63, 64, 65, 67, 68, 69] {
                let handed: Vec<_> = (0..120 + lost)
                    .map(|index| Handed {
                        index,
                        secs: f64::from(index) / 30.0,
                    })
                    .collect();
                let mut case = Case::new("recorder-loss-budget");
                check_recovery(
                    &mut case,
                    recorder_in_flight(arm, encoder),
                    &physical,
                    &physical,
                    &handed,
                    &Default::default(),
                );
                let videotoolbox = encoder == "h264_videotoolbox" && arm == Arm::InProcess;
                assert_eq!(
                    case.classes.contains("loss"),
                    if videotoolbox { lost >= 68 } else { lost >= 64 },
                    "{arm:?}, {encoder}, {lost} lost frames"
                );
                assert_eq!(
                    case.classes.contains("loss-time"),
                    if videotoolbox { lost >= 69 } else { lost >= 65 },
                    "{arm:?}, {encoder}, {lost} lost frames"
                );
                assert!(!case.classes.contains("dropped-complete"));
            }
        }
    }
}

#[test]
fn complete_prefix_keeps_whole_fragments_before_every_truncated_tail() {
    let atom = |kind: &[u8; 4], payload: &[u8]| {
        let mut bytes = ((payload.len() + 8) as u32).to_be_bytes().to_vec();
        bytes.extend_from_slice(kind);
        bytes.extend_from_slice(payload);
        bytes
    };
    let first = [atom(b"moof", &[1, 2]), atom(b"mdat", &[3, 4, 5])].concat();
    let second = [atom(b"moof", &[6]), atom(b"mdat", &[7, 8, 9])].concat();
    for cut in 0..first.len() {
        assert!(complete_fragment_ends(&first[..cut]).is_empty(), "{cut}");
    }
    for cut in 0..second.len() {
        let bytes = [&first[..], &second[..cut]].concat();
        assert_eq!(complete_fragment_ends(&bytes), vec![first.len()], "{cut}");
    }
    let joined = [first.clone(), second].concat();
    assert_eq!(
        complete_fragment_ends(&joined),
        vec![first.len(), joined.len()]
    );
    for tail in [
        vec![0; 8],
        [4u32.to_be_bytes().as_slice(), b"moof"].concat(),
        [u32::MAX.to_be_bytes().as_slice(), b"moof"].concat(),
        [atom(b"moof", &[]), atom(b"moof", &[]), atom(b"mdat", &[])].concat(),
    ] {
        assert_eq!(
            complete_fragment_ends(&[first.clone(), tail].concat()),
            vec![first.len()]
        );
    }
    let extended = [
        atom(b"moof", &[]),
        [
            1u32.to_be_bytes().as_slice(),
            b"mdat",
            19u64.to_be_bytes().as_slice(),
            &[1, 2, 3],
        ]
        .concat(),
    ]
    .concat();
    assert_eq!(complete_fragment_ends(&extended), vec![extended.len()]);
}

#[test]
fn timed_fragment_span_still_rejects_a_delayed_flush() {
    let handed: Vec<_> = (0..=120)
        .step_by(10)
        .map(|index| Handed {
            index,
            secs: f64::from(index) / f64::from(FPS),
        })
        .collect();
    for (count, fails) in [(6, false), (12, true)] {
        let fragment = handed[..count].iter().map(|h| (h.index, h.secs)).collect();
        let mut case = Case::new("timed-fragment-test");
        check_fragment_spans(&mut case, &[fragment], &handed);
        assert_eq!(case.classes.contains("fragment-span"), fails);
    }
}
