use std::{
    io::Write,
    path::PathBuf,
    process::{Child, ChildStdin, Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};

use crate::utils::create_named_pipe;

pub struct FFmpegRecording {
    ffmpeg_stdin: ChildStdin,
}

impl FFmpegRecording {
    pub fn create(mut command: Command) -> Self {
        let mut cmd = command
            .stdin(Stdio::piped())
            .spawn()
            .expect("Failed to start ffmpeg");

        Self {
            ffmpeg_stdin: cmd.stdin.take().unwrap(),
        }
    }

    pub fn stop(mut self) {
        self.ffmpeg_stdin.write_all(b"q").ok();
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

pub struct FFmpegRawVideoSource {
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub input: PathBuf,
    pub output: PathBuf,
    pub pix_fmt: &'static str,
    pub capture: NamedPipeCapture,
}

impl FFmpegRawVideoSource {
    pub fn apply_to_ffmpeg(
        self,
        command: &mut std::process::Command,
        index: u8,
    ) -> NamedPipeCapture {
        let size = format!("{}x{}", self.width, self.height);

        println!("applying to ffmpeg: size: {size}");

        command
            // input
            .args(&["-f", "rawvideo", "-pix_fmt", self.pix_fmt])
            .args(["-s", &size])
            .args(["-r", &self.fps.to_string()])
            .args(["-thread_queue_size", "4096", "-i"])
            .arg(self.input)
            // output
            .args(["-f", "mp4", "-map", &format!("{index}:v")])
            .args(["-codec:v", "libx264", "-preset", "ultrafast"])
            .args(["-pix_fmt", "yuv420p", "-tune", "zerolatency"])
            .args(["-vsync", "1", "-force_key_frames", "expr:gte(t,n_forced*3)"])
            .args(["-movflags", "frag_keyframe+empty_moov"])
            .args([
                "-vf",
                &format!("fps={},scale=in_range=full:out_range=limited", self.fps),
            ])
            .arg(self.output);

        self.capture
    }
}

pub struct FFmpegRawSourceEncoder {
    command: Command,
    source_index: u8,
}

impl FFmpegRawSourceEncoder {
    pub fn new() -> Self {
        Self {
            command: Command::new("ffmpeg"),
            source_index: 0,
        }
    }

    pub fn add_source<R>(&mut self, source: impl FnOnce(&mut Command, u8) -> R) -> R {
        let source_index = self.source_index;
        self.source_index += 1;

        source(&mut self.command, source_index)
    }

    pub fn start(self) -> FFmpegRecording {
        FFmpegRecording::create(self.command)
    }
}
