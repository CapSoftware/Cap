use crate::output_pipeline::core::{HealthSender, PipelineHealthEvent, emit_health};
use anyhow::{Context, Result, anyhow};
use cap_muxer_protocol::{
    Frame, InitAudio, InitVideo, PACKET_FLAG_KEYFRAME, Packet, STREAM_INDEX_AUDIO,
    STREAM_INDEX_VIDEO, StartParams, write_frame,
};
use std::{
    collections::VecDeque,
    io::{BufWriter, Write},
    path::{Path, PathBuf},
    process::{Child, ChildStderr, ChildStdin, Command, ExitStatus, Stdio},
    sync::{
        Arc, OnceLock,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    thread::JoinHandle,
    time::{Duration, Instant},
};
use tracing::{debug, error, info, warn};

pub const ENV_BIN_PATH: &str = "CAP_MUXER_BIN";
const STDERR_RING_LIMIT: usize = 128;
const RESPAWN_COOLDOWN: Duration = Duration::from_millis(500);
const RESPAWN_STABILITY_WINDOW: Duration = Duration::from_secs(5);
pub const EXIT_DISK_FULL: u8 = 60;

static MUXER_BINARY_OVERRIDE: OnceLock<PathBuf> = OnceLock::new();

pub fn set_muxer_binary_override(path: PathBuf) -> Result<(), PathBuf> {
    MUXER_BINARY_OVERRIDE.set(path)
}

pub fn resolve_muxer_binary() -> Result<PathBuf> {
    if let Some(override_path) = MUXER_BINARY_OVERRIDE.get() {
        if override_path.exists() {
            return Ok(override_path.clone());
        }
        return Err(anyhow!(
            "registered cap-muxer override points to missing path: {}",
            override_path.display()
        ));
    }

    if let Ok(override_path) = std::env::var(ENV_BIN_PATH) {
        let path = PathBuf::from(override_path);
        if path.exists() {
            return Ok(path);
        }
        return Err(anyhow!(
            "{ENV_BIN_PATH} points to missing path: {}",
            path.display()
        ));
    }

    let exe = std::env::current_exe().context("current_exe")?;
    if let Some(dir) = exe.parent() {
        let candidate = dir.join(bin_name());
        if candidate.exists() {
            return Ok(candidate);
        }

        let alt_dir = dir.join("..").join("MacOS");
        let candidate = alt_dir.join(bin_name());
        if candidate.exists() {
            return Ok(candidate);
        }
    }

    if let Ok(cwd) = std::env::current_dir() {
        let target_debug = cwd.join("target/debug").join(bin_name());
        if target_debug.exists() {
            return Ok(target_debug);
        }
        let target_release = cwd.join("target/release").join(bin_name());
        if target_release.exists() {
            return Ok(target_release);
        }
    }

    Err(anyhow!(
        "cap-muxer binary not found; set {ENV_BIN_PATH} or place it next to the main executable"
    ))
}

fn bin_name() -> &'static str {
    if cfg!(windows) {
        "cap-muxer.exe"
    } else {
        "cap-muxer"
    }
}

#[derive(Debug, Clone)]
pub struct VideoStreamInit {
    pub codec: String,
    pub width: u32,
    pub height: u32,
    pub frame_rate: (i32, i32),
    pub time_base: (i32, i32),
    pub extradata: Vec<u8>,
    pub segment_duration_ms: u32,
}

#[derive(Debug, Clone)]
pub struct AudioStreamInit {
    pub codec: String,
    pub sample_rate: u32,
    pub channels: u16,
    pub sample_format: String,
    pub time_base: (i32, i32),
    pub extradata: Vec<u8>,
}

#[derive(Debug, Clone)]
pub struct MuxerSubprocessConfig {
    pub output_directory: PathBuf,
    pub init_segment_name: String,
    pub media_segment_pattern: String,
    pub video_init: Option<VideoStreamInit>,
    pub audio_init: Option<AudioStreamInit>,
}

impl MuxerSubprocessConfig {
    pub fn with_video(mut self, video: VideoStreamInit) -> Self {
        self.video_init = Some(video);
        self
    }

    pub fn with_audio(mut self, audio: AudioStreamInit) -> Self {
        self.audio_init = Some(audio);
        self
    }
}

pub struct MuxerSubprocess {
    child: Option<Child>,
    stdin: Option<BufWriter<ChildStdin>>,
    stderr_thread: Option<JoinHandle<Vec<String>>>,
    stderr_lines: Arc<parking_lot::Mutex<VecDeque<String>>>,
    bin_path: PathBuf,
    config: MuxerSubprocessConfig,
    health_tx: Option<HealthSender>,
    packets_written: Arc<AtomicU64>,
    started_at: Instant,
    crash_reported: Arc<AtomicBool>,
}

#[derive(Debug, thiserror::Error)]
pub enum MuxerSubprocessError {
    #[error("spawn: {0:#}")]
    Spawn(anyhow::Error),
    #[error("subprocess exited during init: {0}")]
    ExitDuringInit(String),
    #[error("write: {0:#}")]
    Write(anyhow::Error),
    #[error("subprocess crashed: {0}")]
    Crashed(String),
    #[error("respawn exhausted after {attempts} attempts")]
    RespawnExhausted { attempts: u32 },
    #[error("disk full: {0}")]
    DiskFull(String),
}

impl MuxerSubprocess {
    pub fn spawn(
        bin_path: PathBuf,
        config: MuxerSubprocessConfig,
        health_tx: Option<HealthSender>,
    ) -> Result<Self, MuxerSubprocessError> {
        let mut child = Command::new(&bin_path)
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .env(
                "CAP_MUXER_LOG",
                std::env::var("CAP_MUXER_LOG").unwrap_or_else(|_| "info".to_string()),
            )
            .spawn()
            .map_err(|e| {
                MuxerSubprocessError::Spawn(anyhow!("failed to spawn {}: {e}", bin_path.display()))
            })?;

        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| MuxerSubprocessError::Spawn(anyhow!("subprocess stdin missing")))?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| MuxerSubprocessError::Spawn(anyhow!("subprocess stderr missing")))?;

        let stderr_lines = Arc::new(parking_lot::Mutex::new(VecDeque::<String>::new()));
        let stderr_thread = match spawn_stderr_reader(stderr, stderr_lines.clone()) {
            Ok(handle) => Some(handle),
            Err(e) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(e);
            }
        };

        let mut subprocess = Self {
            child: Some(child),
            stdin: Some(BufWriter::with_capacity(1024 * 1024, stdin)),
            stderr_thread,
            stderr_lines,
            bin_path,
            config: config.clone(),
            health_tx,
            packets_written: Arc::new(AtomicU64::new(0)),
            started_at: Instant::now(),
            crash_reported: Arc::new(AtomicBool::new(false)),
        };

        subprocess.send_init_frames()?;

        info!(
            bin_path = %subprocess.bin_path.display(),
            output_dir = %config.output_directory.display(),
            "cap-muxer subprocess spawned"
        );

        Ok(subprocess)
    }

    fn send_init_frames(&mut self) -> Result<(), MuxerSubprocessError> {
        let stdin = self
            .stdin
            .as_mut()
            .ok_or_else(|| MuxerSubprocessError::Write(anyhow!("stdin closed")))?;

        if let Some(video) = &self.config.video_init {
            let frame = Frame::InitVideo(InitVideo {
                codec: video.codec.clone(),
                width: video.width,
                height: video.height,
                frame_rate_num: video.frame_rate.0,
                frame_rate_den: video.frame_rate.1,
                time_base_num: video.time_base.0,
                time_base_den: video.time_base.1,
                extradata: video.extradata.clone(),
                segment_duration_ms: video.segment_duration_ms,
            });
            write_frame(stdin, &frame)
                .map_err(|e| MuxerSubprocessError::Write(anyhow!("init_video: {e}")))?;
        }

        if let Some(audio) = &self.config.audio_init {
            let frame = Frame::InitAudio(InitAudio {
                codec: audio.codec.clone(),
                sample_rate: audio.sample_rate,
                channels: audio.channels,
                sample_format: audio.sample_format.clone(),
                time_base_num: audio.time_base.0,
                time_base_den: audio.time_base.1,
                extradata: audio.extradata.clone(),
            });
            write_frame(stdin, &frame)
                .map_err(|e| MuxerSubprocessError::Write(anyhow!("init_audio: {e}")))?;
        }

        let start = Frame::Start(StartParams {
            output_directory: self.config.output_directory.to_string_lossy().to_string(),
            init_segment_name: self.config.init_segment_name.clone(),
            media_segment_pattern: self.config.media_segment_pattern.clone(),
        });
        write_frame(stdin, &start)
            .map_err(|e| MuxerSubprocessError::Write(anyhow!("start: {e}")))?;

        stdin
            .flush()
            .map_err(|e| MuxerSubprocessError::Write(anyhow!("flush after start: {e}")))?;

        std::thread::sleep(Duration::from_millis(100));
        if let Some(child) = self.child.as_mut()
            && let Ok(Some(status)) = child.try_wait()
        {
            let reason = self.drain_stderr_reason(status);
            return Err(MuxerSubprocessError::ExitDuringInit(reason));
        }

        Ok(())
    }

    pub fn write_video_packet(
        &mut self,
        pts_time_base_units: i64,
        dts_time_base_units: i64,
        duration_time_base_units: u64,
        is_keyframe: bool,
        data: &[u8],
    ) -> Result<(), MuxerSubprocessError> {
        let mut flags = 0u8;
        if is_keyframe {
            flags |= PACKET_FLAG_KEYFRAME;
        }
        self.write_packet(
            STREAM_INDEX_VIDEO,
            pts_time_base_units,
            dts_time_base_units,
            duration_time_base_units,
            flags,
            data,
        )
    }

    pub fn write_audio_packet(
        &mut self,
        pts_time_base_units: i64,
        dts_time_base_units: i64,
        duration_time_base_units: u64,
        data: &[u8],
    ) -> Result<(), MuxerSubprocessError> {
        self.write_packet(
            STREAM_INDEX_AUDIO,
            pts_time_base_units,
            dts_time_base_units,
            duration_time_base_units,
            0,
            data,
        )
    }

    fn write_packet(
        &mut self,
        stream_index: u8,
        pts: i64,
        dts: i64,
        duration: u64,
        flags: u8,
        data: &[u8],
    ) -> Result<(), MuxerSubprocessError> {
        let stdin = self
            .stdin
            .as_mut()
            .ok_or_else(|| MuxerSubprocessError::Write(anyhow!("stdin closed")))?;

        let frame = Frame::Packet(Packet {
            stream_index,
            pts,
            dts,
            duration,
            flags,
            data: data.to_vec(),
        });

        match write_frame(stdin, &frame) {
            Ok(()) => {
                self.packets_written.fetch_add(1, Ordering::Relaxed);
                Ok(())
            }
            Err(e) => {
                let reason = self.on_write_failure(&format!("packet write: {e}"));
                if self.exit_code_if_exited() == Some(EXIT_DISK_FULL as i32) {
                    Err(MuxerSubprocessError::DiskFull(reason))
                } else {
                    Err(MuxerSubprocessError::Crashed(reason))
                }
            }
        }
    }

    fn on_write_failure(&mut self, context: &str) -> String {
        let stderr_tail = self.snapshot_stderr();
        let exit_code = self.exit_code_if_exited();
        let status_str = exit_code
            .map(|c| format!("exit_code={c}"))
            .unwrap_or_else(|| self.reap_if_exited());
        let reason = format!(
            "{context}; exit={status_str}; stderr_tail={:?}",
            stderr_tail.last()
        );
        if exit_code == Some(EXIT_DISK_FULL as i32) {
            self.report_disk_full(&reason);
        } else {
            self.report_crashed(&reason);
        }
        reason
    }

    fn exit_code_if_exited(&mut self) -> Option<i32> {
        if let Some(child) = self.child.as_mut()
            && let Ok(Some(status)) = child.try_wait()
        {
            return status.code();
        }
        None
    }

    pub fn disk_full_observed(&mut self) -> bool {
        self.exit_code_if_exited() == Some(EXIT_DISK_FULL as i32)
    }

    fn reap_if_exited(&mut self) -> String {
        match self.child.as_mut() {
            Some(child) => match child.try_wait() {
                Ok(Some(status)) => format!("{status:?}"),
                Ok(None) => "still_alive".to_string(),
                Err(e) => format!("wait_err({e})"),
            },
            None => "already_reaped".to_string(),
        }
    }

    fn drain_stderr_reason(&mut self, status: ExitStatus) -> String {
        let tail = self.snapshot_stderr();
        let code = status
            .code()
            .map(|c| c.to_string())
            .unwrap_or_else(|| "signal".to_string());
        format!(
            "exit_code={code} stderr={:?}",
            tail.iter().rev().take(3).rev().cloned().collect::<Vec<_>>()
        )
    }

    fn snapshot_stderr(&self) -> Vec<String> {
        self.stderr_lines.lock().iter().cloned().collect()
    }

    fn report_crashed(&self, reason: &str) {
        if self
            .crash_reported
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            return;
        }
        error!(reason, "cap-muxer subprocess crashed");
        if let Some(tx) = &self.health_tx {
            emit_health(
                tx,
                PipelineHealthEvent::MuxerCrashed {
                    reason: reason.to_string(),
                },
            );
        }
    }

    fn report_disk_full(&self, reason: &str) {
        if self
            .crash_reported
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            return;
        }
        error!(reason, "cap-muxer subprocess exited with disk full");
        if let Some(tx) = &self.health_tx {
            emit_health(
                tx,
                PipelineHealthEvent::DiskSpaceExhausted { bytes_remaining: 0 },
            );
        }
    }

    pub fn packets_written(&self) -> u64 {
        self.packets_written.load(Ordering::Acquire)
    }

    pub fn uptime(&self) -> Duration {
        self.started_at.elapsed()
    }

    #[doc(hidden)]
    pub fn kill_for_testing(&mut self) -> std::io::Result<()> {
        if let Some(child) = self.child.as_mut() {
            child.kill()?;
            let _ = child.wait();
        }
        Ok(())
    }

    pub fn finish(mut self) -> Result<MuxerSubprocessReport, MuxerSubprocessError> {
        if let Some(mut stdin) = self.stdin.take() {
            let _ = write_frame(&mut stdin, &Frame::Finish);
            let _ = stdin.flush();
            drop(stdin);
        }

        let packets = self.packets_written.load(Ordering::Acquire);
        let mut status = None;
        if let Some(mut child) = self.child.take() {
            match child.wait() {
                Ok(s) => status = Some(s),
                Err(e) => {
                    warn!("cap-muxer wait failed: {e}");
                }
            }
        }

        let stderr_tail = if let Some(handle) = self.stderr_thread.take() {
            handle.join().unwrap_or_default()
        } else {
            self.snapshot_stderr()
        };

        let exit_code = status.as_ref().and_then(|s| s.code());
        let success = matches!(exit_code, Some(0));
        if !success {
            let reason = format!(
                "non-zero exit {:?}: {:?}",
                exit_code,
                stderr_tail.iter().rev().take(3).collect::<Vec<_>>()
            );
            let is_disk_full = exit_code == Some(EXIT_DISK_FULL as i32);
            if is_disk_full {
                self.report_disk_full(&reason);
            } else {
                self.report_crashed(&reason);
            }
            return Err(if is_disk_full {
                MuxerSubprocessError::DiskFull(reason)
            } else {
                MuxerSubprocessError::Crashed(reason)
            });
        }

        info!(
            packets,
            uptime_secs = self.started_at.elapsed().as_secs_f64(),
            "cap-muxer subprocess finished cleanly"
        );

        Ok(MuxerSubprocessReport {
            packets_written: packets,
            uptime: self.started_at.elapsed(),
            stderr_tail,
            exit_code,
        })
    }
}

impl Drop for MuxerSubprocess {
    fn drop(&mut self) {
        if let Some(mut child) = self.child.take()
            && let Ok(None) = child.try_wait()
        {
            warn!("cap-muxer subprocess being dropped while still running; killing");
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

#[derive(Debug)]
pub struct MuxerSubprocessReport {
    pub packets_written: u64,
    pub uptime: Duration,
    pub stderr_tail: Vec<String>,
    pub exit_code: Option<i32>,
}

fn spawn_stderr_reader(
    stderr: ChildStderr,
    lines: Arc<parking_lot::Mutex<VecDeque<String>>>,
) -> Result<JoinHandle<Vec<String>>, MuxerSubprocessError> {
    std::thread::Builder::new()
        .name("cap-muxer-stderr".into())
        .spawn(move || {
            use std::io::{BufRead, BufReader};
            let reader = BufReader::new(stderr);
            let mut final_lines = Vec::new();
            for line_res in reader.lines() {
                match line_res {
                    Ok(line) => {
                        debug!(target: "cap_muxer_stderr", "{line}");
                        let mut guard = lines.lock();
                        guard.push_back(line.clone());
                        if guard.len() > STDERR_RING_LIMIT {
                            guard.pop_front();
                        }
                        drop(guard);
                        final_lines.push(line);
                        if final_lines.len() > STDERR_RING_LIMIT * 4 {
                            final_lines.drain(0..STDERR_RING_LIMIT);
                        }
                    }
                    Err(e) => {
                        debug!(target: "cap_muxer_stderr", "read err: {e}");
                        break;
                    }
                }
            }
            final_lines
        })
        .map_err(|e| {
            MuxerSubprocessError::Spawn(anyhow!("failed to spawn cap-muxer-stderr thread: {e}"))
        })
}

pub struct RespawningMuxerSubprocess {
    current: Option<MuxerSubprocess>,
    bin_path: PathBuf,
    config: MuxerSubprocessConfig,
    health_tx: Option<HealthSender>,
    respawn_attempts: u32,
    consecutive_fast_failures: u32,
    max_consecutive_fast_failures: u32,
    last_crash_at: Option<Instant>,
    current_spawned_at: Instant,
}

impl RespawningMuxerSubprocess {
    pub fn new(
        bin_path: PathBuf,
        config: MuxerSubprocessConfig,
        health_tx: Option<HealthSender>,
        max_consecutive_fast_failures: u32,
    ) -> Result<Self, MuxerSubprocessError> {
        let current = Some(MuxerSubprocess::spawn(
            bin_path.clone(),
            config.clone(),
            health_tx.clone(),
        )?);
        Ok(Self {
            current,
            bin_path,
            config,
            health_tx,
            respawn_attempts: 0,
            consecutive_fast_failures: 0,
            max_consecutive_fast_failures,
            last_crash_at: None,
            current_spawned_at: Instant::now(),
        })
    }

    pub fn write_video_packet(
        &mut self,
        pts: i64,
        dts: i64,
        duration: u64,
        is_keyframe: bool,
        data: &[u8],
    ) -> Result<(), MuxerSubprocessError> {
        self.run_with_respawn(|child| {
            child.write_video_packet(pts, dts, duration, is_keyframe, data)
        })
    }

    pub fn write_audio_packet(
        &mut self,
        pts: i64,
        dts: i64,
        duration: u64,
        data: &[u8],
    ) -> Result<(), MuxerSubprocessError> {
        self.run_with_respawn(|child| child.write_audio_packet(pts, dts, duration, data))
    }

    fn run_with_respawn<F>(&mut self, mut op: F) -> Result<(), MuxerSubprocessError>
    where
        F: FnMut(&mut MuxerSubprocess) -> Result<(), MuxerSubprocessError>,
    {
        loop {
            let Some(current) = self.current.as_mut() else {
                if self.consecutive_fast_failures > self.max_consecutive_fast_failures {
                    return Err(MuxerSubprocessError::RespawnExhausted {
                        attempts: self.respawn_attempts,
                    });
                }
                self.spawn_new()?;
                continue;
            };

            match op(current) {
                Ok(()) => return Ok(()),
                Err(MuxerSubprocessError::DiskFull(reason)) => {
                    self.current = None;
                    return Err(MuxerSubprocessError::DiskFull(reason));
                }
                Err(MuxerSubprocessError::Crashed(reason)) => {
                    let uptime = self.current_spawned_at.elapsed();
                    if uptime > RESPAWN_STABILITY_WINDOW {
                        if self.consecutive_fast_failures > 0 {
                            info!(
                                stable_uptime_secs = uptime.as_secs_f64(),
                                previous_fast_failures = self.consecutive_fast_failures,
                                "subprocess proved stable; resetting fast-failure counter"
                            );
                        }
                        self.consecutive_fast_failures = 0;
                    } else {
                        self.consecutive_fast_failures += 1;
                    }
                    warn!(
                        reason,
                        uptime_secs = uptime.as_secs_f64(),
                        consecutive_fast_failures = self.consecutive_fast_failures,
                        max_consecutive_fast_failures = self.max_consecutive_fast_failures,
                        "subprocess write failed; evaluating respawn"
                    );
                    self.current = None;
                    if self.consecutive_fast_failures > self.max_consecutive_fast_failures {
                        return Err(MuxerSubprocessError::RespawnExhausted {
                            attempts: self.respawn_attempts,
                        });
                    }
                    if let Some(last) = self.last_crash_at {
                        let since = last.elapsed();
                        if since < RESPAWN_COOLDOWN {
                            std::thread::sleep(RESPAWN_COOLDOWN.saturating_sub(since));
                        }
                    }
                    self.last_crash_at = Some(Instant::now());
                }
                Err(other) => return Err(other),
            }
        }
    }

    fn spawn_new(&mut self) -> Result<(), MuxerSubprocessError> {
        self.respawn_attempts += 1;
        let mut respawned_config = self.config.clone();
        let respawn_dir_name = format!("respawn-{}", self.respawn_attempts);
        respawned_config.output_directory = self.config.output_directory.join(respawn_dir_name);

        info!(
            attempt = self.respawn_attempts,
            output_dir = %respawned_config.output_directory.display(),
            "respawning cap-muxer subprocess into isolated directory"
        );

        let new = MuxerSubprocess::spawn(
            self.bin_path.clone(),
            respawned_config,
            self.health_tx.clone(),
        )?;
        self.current = Some(new);
        self.current_spawned_at = Instant::now();
        Ok(())
    }

    pub fn finish(mut self) -> Result<MuxerSubprocessReport, MuxerSubprocessError> {
        if let Some(current) = self.current.take() {
            current.finish()
        } else {
            Err(MuxerSubprocessError::Crashed(
                "no active subprocess at finish".to_string(),
            ))
        }
    }

    pub fn respawn_attempts(&self) -> u32 {
        self.respawn_attempts
    }

    pub fn is_exhausted(&self) -> bool {
        self.current.is_none()
            && self.consecutive_fast_failures > self.max_consecutive_fast_failures
    }

    pub fn max_consecutive_fast_failures(&self) -> u32 {
        self.max_consecutive_fast_failures
    }

    #[deprecated(
        note = "Misleading name — returns max_consecutive_fast_failures, not a total respawn cap. Use max_consecutive_fast_failures() instead."
    )]
    pub fn max_respawns(&self) -> u32 {
        self.max_consecutive_fast_failures
    }
}

pub fn feature_enabled() -> bool {
    std::env::var("CAP_OUT_OF_PROCESS_MUXER")
        .ok()
        .filter(|v| v == "1" || v.eq_ignore_ascii_case("true"))
        .is_some()
}

pub fn output_path_from_dir(dir: &Path) -> PathBuf {
    dir.to_path_buf()
}
