//! Real-capture stimulus: a helper process (`cap-verify-stimulus`) that shows
//! a window rendering the screen marker of a monotonically increasing frame
//! index at a fixed rate and plays system-audio markers through the default
//! output, logging the host time of every presented frame and every marker.
//!
//! Protocol: the helper presents frame 0 and prints `ready`; the test starts
//! its recording and writes `go`; the helper then advances one index per
//! `1 / fps` (holding the picture inside `holds`), prints `done` after the
//! last frame and keeps the last frame on screen until `quit` (or EOF).
//! Every event is a JSON line in the log file; host times are mach absolute
//! ticks, the clock Cap stamps captured media with on macOS.

use std::path::Path;

use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct StimulusSpec {
    pub fps: f64,
    pub seconds: f64,
    /// (start, length) seconds after `go` during which the picture is held.
    pub holds: Vec<(f64, f64)>,
    /// Pseudo-random achromatic noise bands above and below the marker, new
    /// every frame, so the encoder sees dense changing content.
    pub busy: bool,
    /// Seconds of moving noise before `ready` (frame 0 keeps showing).
    pub warmup: f64,
    pub audio: bool,
    pub audio_period: f64,
    /// Host time the system-audio marker schedule counts from (0 = helper
    /// start). Share it with the other marker sources of a case.
    pub audio_origin: u64,
    /// `None` = borderless fullscreen on the primary display; otherwise a
    /// window at (x, y, width, height) in points.
    pub window: Option<(i32, i32, u32, u32)>,
}

impl StimulusSpec {
    pub fn frame_count(&self) -> u32 {
        (self.seconds * self.fps).round() as u32
    }

    /// Seconds after `go` at which frame `index` (>= 1) is due.
    pub fn due_secs(&self, index: u32) -> f64 {
        f64::from(index.saturating_sub(1)) / self.fps
    }

    pub fn held(&self, secs: f64) -> bool {
        self.holds.iter().any(|&(s, l)| secs > s && secs < s + l)
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "event", rename_all = "snake_case")]
pub enum StimulusEvent {
    Ready {
        host: u64,
        width: u32,
        height: u32,
        scale: f64,
    },
    Go {
        host: u64,
    },
    Frame {
        index: u32,
        /// Host time right after the frame was handed to the window server.
        host: u64,
        #[serde(default)]
        render_started: Option<u64>,
    },
    AudioStarted {
        device: String,
        sample_rate: u32,
        channels: u16,
    },
    AudioUnavailable {
        reason: String,
    },
    /// Chirp start of a system-audio marker at the output, from the render
    /// callback's host time.
    Audio {
        index: u32,
        host: u64,
    },
    Done {
        host: u64,
    },
    /// A frame delivered to the stimulus's own ScreenCaptureKit stream (a
    /// separate client in a separate process from the recorder), with the
    /// host time it was captured: independent proof of what the window
    /// server composited and the capture service delivered.
    Observed {
        host: u64,
    },
    ObserverUnavailable {
        reason: String,
    },
    /// Kernel status of the stimulus's priority requests (0 = applied).
    Priority {
        qos: i32,
        realtime: i32,
    },
    /// Scheduling diagnostics for the frame just presented: how late the
    /// run loop woke for it, how long the loop took to get back to waiting
    /// after presenting, and the main thread's scheduler state.
    Sched {
        index: u32,
        cause: String,
        wake_late_us: Option<i64>,
        post_present_us: i64,
        cur_pri: i32,
        base_pri: i32,
        cpu_us: u64,
    },
}

pub fn read_log(path: &Path) -> anyhow::Result<Vec<StimulusEvent>> {
    let text = std::fs::read_to_string(path)?;
    text.lines()
        .filter(|l| !l.trim().is_empty())
        .map(|l| serde_json::from_str(l).map_err(Into::into))
        .collect()
}

/// The stimulus's real-time sentinel log, next to its event log.
pub const SENTINEL_FILE: &str = "sentinel.txt";
/// The sentinel's wake period.
pub const SENTINEL_PERIOD_SECS: f64 = 0.002;

/// Every wake of the stimulus's real-time sentinel thread (host ticks) and
/// the scheduling it ran under.
#[cfg(any(target_os = "macos", windows))]
#[derive(Clone, Debug)]
pub struct SentinelLog {
    pub realtime: crate::sched::Realtime,
    pub end: Option<crate::sched::ThreadState>,
    pub wakes: Vec<u64>,
}

#[cfg(any(target_os = "macos", windows))]
impl SentinelLog {
    pub fn read(path: &std::path::Path) -> anyhow::Result<Self> {
        #[derive(serde::Deserialize)]
        struct Header {
            first: Option<u64>,
            realtime: crate::sched::Realtime,
            end: Option<crate::sched::ThreadState>,
        }
        let text = std::fs::read_to_string(path)?;
        let mut lines = text.lines();
        let header: Header = serde_json::from_str(lines.next().unwrap_or_default())?;
        let mut wakes = Vec::new();
        if let Some(mut at) = header.first {
            wakes.push(at);
            for line in lines {
                at += line.trim().parse::<u64>()?;
                wakes.push(at);
            }
        }
        Ok(Self {
            realtime: header.realtime,
            end: header.end,
            wakes,
        })
    }

    /// Gaps between consecutive wakes: (start host, seconds).
    pub fn gaps(&self) -> impl Iterator<Item = (u64, f64)> + '_ {
        self.wakes.windows(2).map(|w| (w[0], host_secs(w[1], w[0])))
    }
}

#[cfg(target_os = "macos")]
pub fn host_now() -> u64 {
    cidre::mach::abs_time()
}

/// Seconds between two mach host times (`a - b`).
#[cfg(target_os = "macos")]
pub fn host_secs(a: u64, b: u64) -> f64 {
    let info = cidre::mach::TimeBaseInfo::new();
    let ticks = a as f64 - b as f64;
    ticks * f64::from(info.numer) / f64::from(info.denom) / 1e9
}

#[cfg(target_os = "macos")]
pub fn host_add_secs(a: u64, secs: f64) -> u64 {
    let info = cidre::mach::TimeBaseInfo::new();
    (a as f64 + secs * 1e9 * f64::from(info.denom) / f64::from(info.numer)).round() as u64
}

/// QueryPerformanceCounter ticks, the clock Windows capture is stamped with.
#[cfg(windows)]
pub fn host_now() -> u64 {
    crate::sched::qpc_now()
}

/// Seconds between two host times (`a - b`).
#[cfg(windows)]
pub fn host_secs(a: u64, b: u64) -> f64 {
    (a as f64 - b as f64) / crate::sched::qpc_frequency() as f64
}

#[cfg(windows)]
pub fn host_add_secs(a: u64, secs: f64) -> u64 {
    (a as f64 + secs * crate::sched::qpc_frequency() as f64).round() as u64
}

#[cfg(any(target_os = "macos", windows))]
pub use process::StimulusProcess;

#[cfg(any(target_os = "macos", windows))]
mod process {
    use std::{
        io::{BufRead, BufReader, Write},
        path::{Path, PathBuf},
        process::{Child, ChildStdin, Command, Stdio},
        sync::mpsc,
        time::Duration,
    };

    use anyhow::{Context, bail};

    use super::{StimulusEvent, StimulusSpec, read_log};

    pub struct StimulusProcess {
        child: Child,
        stdin: Option<ChildStdin>,
        lines: mpsc::Receiver<String>,
        log: PathBuf,
    }

    impl StimulusProcess {
        pub fn spawn(binary: &Path, spec: &StimulusSpec, log: &Path) -> anyhow::Result<Self> {
            let mut child = Command::new(binary)
                .arg(serde_json::to_string(spec)?)
                .arg(log)
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::inherit())
                .spawn()
                .with_context(|| format!("spawn {}", binary.display()))?;
            let stdout = child.stdout.take().context("stimulus stdout")?;
            let (tx, lines) = mpsc::channel();
            std::thread::spawn(move || {
                for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                    if tx.send(line).is_err() {
                        break;
                    }
                }
            });
            let stdin = child.stdin.take();
            Ok(Self {
                child,
                stdin,
                lines,
                log: log.to_path_buf(),
            })
        }

        pub fn pid(&self) -> u32 {
            self.child.id()
        }

        pub fn wait_for(&mut self, word: &str, timeout: Duration) -> anyhow::Result<()> {
            let deadline = std::time::Instant::now() + timeout;
            loop {
                let left = deadline.saturating_duration_since(std::time::Instant::now());
                match self.lines.recv_timeout(left) {
                    Ok(line) if line.trim() == word => return Ok(()),
                    Ok(line) if line.starts_with("error") => bail!("stimulus: {line}"),
                    Ok(_) => {}
                    Err(mpsc::RecvTimeoutError::Timeout) => {
                        bail!("stimulus did not report `{word}` within {timeout:?}")
                    }
                    Err(mpsc::RecvTimeoutError::Disconnected) => {
                        bail!("stimulus exited before `{word}`")
                    }
                }
            }
        }

        pub fn send(&mut self, word: &str) -> anyhow::Result<()> {
            let stdin = self.stdin.as_mut().context("stimulus stdin closed")?;
            writeln!(stdin, "{word}")?;
            stdin.flush()?;
            Ok(())
        }

        /// Closes the window and returns the event log.
        pub fn finish(mut self) -> anyhow::Result<Vec<StimulusEvent>> {
            let _ = self.send("quit");
            self.stdin = None;
            let deadline = std::time::Instant::now() + Duration::from_secs(10);
            loop {
                if self.child.try_wait()?.is_some() {
                    break;
                }
                if std::time::Instant::now() > deadline {
                    let _ = self.child.kill();
                    let _ = self.child.wait();
                    break;
                }
                std::thread::sleep(Duration::from_millis(20));
            }
            read_log(&self.log)
        }
    }

    impl Drop for StimulusProcess {
        fn drop(&mut self) {
            if matches!(self.child.try_wait(), Ok(None)) {
                let _ = self.child.kill();
                let _ = self.child.wait();
            }
        }
    }
}
