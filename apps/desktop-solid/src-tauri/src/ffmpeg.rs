use std::{
    ffi::OsString,
    io::Write,
    ops::Deref,
    path::PathBuf,
    process::{Child, ChildStdin, Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};

use crate::utils::create_named_pipe;

pub struct FFmpegProcess {
    ffmpeg_stdin: ChildStdin,
    cmd: Child,
}

impl FFmpegProcess {
    pub fn spawn(mut command: Command) -> Self {
        let mut cmd = command
            .stdin(Stdio::piped())
            .spawn()
            .expect("Failed to start ffmpeg");

        Self {
            ffmpeg_stdin: cmd.stdin.take().unwrap(),
            cmd,
        }
    }

    pub fn stop(&mut self) {
        self.ffmpeg_stdin.write_all(b"q").ok();
        self.cmd.wait().ok();
    }
}

pub struct NamedPipeCapture {
    path: PathBuf,
    is_stopped: Arc<AtomicBool>,
}

impl NamedPipeCapture {
    pub fn new(path: &PathBuf) -> (Self, Arc<AtomicBool>) {
        create_named_pipe(&path).unwrap();

        let stop = Arc::new(AtomicBool::new(false));

        (
            Self {
                path: path.clone(),
                is_stopped: stop.clone(),
            },
            stop.clone(),
        )
    }

    pub fn path(&self) -> &PathBuf {
        &self.path
    }

    pub fn stop(&self) {
        self.is_stopped.store(true, Ordering::Relaxed);
    }
}

pub struct FFmpegInput<T> {
    inner: T,
    pub index: u8,
}

impl<T> Deref for FFmpegInput<T> {
    type Target = T;

    fn deref(&self) -> &Self::Target {
        &self.inner
    }
}

pub trait ApplyFFmpegArgs {
    fn apply_ffmpeg_args(&self, command: &mut Command);
}

pub struct FFmpegRawVideoInput {
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub pix_fmt: &'static str,
    pub input: OsString,
}

impl ApplyFFmpegArgs for FFmpegRawVideoInput {
    fn apply_ffmpeg_args(&self, command: &mut Command) {
        let size = format!("{}x{}", self.width, self.height);

        command
            .args(&["-f", "rawvideo", "-pix_fmt", self.pix_fmt])
            .args(["-s", &size])
            .args(["-r", &self.fps.to_string()])
            .args(["-thread_queue_size", "4096", "-i"])
            .arg(&self.input);
    }
}

pub struct FFmpegRawAudioSource {
    pub sample_format: String,
    pub sample_rate: u32,
    pub channels: u16,
    pub input: OsString,
}

impl ApplyFFmpegArgs for FFmpegRawAudioSource {
    fn apply_ffmpeg_args(&self, command: &mut Command) {
        command
            .args(["-f", &self.sample_format])
            .args(["-ar", &self.sample_rate.to_string()])
            .args(["-ac", &self.channels.to_string()])
            .args(["-thread_queue_size", "4096", "-i"])
            .arg(&self.input);
    }
}

pub struct FFmpeg {
    pub command: Command,
    source_index: u8,
}

impl FFmpeg {
    pub fn new() -> Self {
        Self {
            command: Command::new("ffmpeg"),
            source_index: 0,
        }
    }

    pub fn add_input<S: ApplyFFmpegArgs>(&mut self, source: S) -> FFmpegInput<S> {
        let source_index = self.source_index;
        self.source_index += 1;

        source.apply_ffmpeg_args(&mut self.command);

        FFmpegInput {
            inner: source,
            index: source_index,
        }
    }

    pub fn start(self) -> FFmpegProcess {
        FFmpegProcess::spawn(self.command)
    }
}
