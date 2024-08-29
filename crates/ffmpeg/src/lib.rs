mod utils;
pub use utils::*;

use std::{
    ffi::OsString,
    io::{Read, Write},
    ops::Deref,
    path::PathBuf,
    process::{Child, ChildStdin, Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};

use ffmpeg_sidecar::{
    command::ffmpeg_is_installed,
    download::{check_latest_version, download_ffmpeg_package, ffmpeg_download_url, unpack_ffmpeg},
    paths::sidecar_dir,
    version::ffmpeg_version,
};

use cap_utils::create_named_pipe;

pub struct FFmpegProcess {
    pub ffmpeg_stdin: ChildStdin,
    cmd: Child,
}

impl FFmpegProcess {
    pub fn spawn(mut command: Command) -> Self {
        let mut cmd = command.stdin(Stdio::piped()).spawn().unwrap_or_else(|e| {
            println!("Failed to start FFmpeg: {}", e);
            println!("Command: {:?}", command);
            panic!("Failed to start FFmpeg");
        });

        let ffmpeg_stdin = cmd.stdin.take().unwrap_or_else(|| {
            println!("Failed to capture FFmpeg stdin");
            panic!("Failed to capture FFmpeg stdin");
        });

        Self { ffmpeg_stdin, cmd }
    }

    pub fn write(&mut self, data: &[u8]) -> std::io::Result<()> {
        self.ffmpeg_stdin.write_all(data)
    }

    pub fn stop(&mut self) {
        self.ffmpeg_stdin.write_all(b"q").ok();
        println!("Sent stop command to FFmpeg");
    }

    pub fn wait(&mut self) -> std::io::Result<std::process::ExitStatus> {
        self.cmd.wait()
    }

    pub fn kill(&mut self) {
        let _ = self.cmd.kill();
    }

    pub fn wait_with_timeout(
        &mut self,
        timeout: std::time::Duration,
    ) -> std::io::Result<Option<std::process::ExitStatus>> {
        let start = std::time::Instant::now();
        while start.elapsed() < timeout {
            match self.cmd.try_wait()? {
                Some(status) => {
                    return Ok(Some(status));
                }
                None => std::thread::sleep(std::time::Duration::from_millis(100)),
            }
        }
        Ok(None)
    }

    pub fn read_video_frame(
        &mut self,
        frame_size: usize,
    ) -> Result<Option<Vec<u8>>, std::io::Error> {
        let mut buffer = vec![0u8; frame_size];
        match self.cmd.stdout.as_mut().unwrap().read_exact(&mut buffer) {
            Ok(_) => {
                println!("Read video frame of size: {}", buffer.len());
                Ok(Some(buffer))
            }
            Err(ref e) if e.kind() == std::io::ErrorKind::UnexpectedEof => Ok(None),
            Err(e) => Err(e),
        }
    }

    pub fn write_video_frame(&mut self, data: &[u8]) -> std::io::Result<()> {
        let mut remaining = data;
        while !remaining.is_empty() {
            match self.ffmpeg_stdin.write(remaining) {
                Ok(0) => {
                    return Err(std::io::Error::new(
                        std::io::ErrorKind::WriteZero,
                        "Failed to write data to FFmpeg",
                    ));
                }
                Ok(n) => {
                    remaining = &remaining[n..];
                }
                Err(ref e) if e.kind() == std::io::ErrorKind::Interrupted => {
                    continue;
                }
                Err(e) => {
                    return Err(e);
                }
            }
        }
        self.ffmpeg_stdin.flush()?;
        Ok(())
    }
}

pub struct NamedPipeCapture {
    path: PathBuf,
    is_stopped: Arc<AtomicBool>,
}

impl NamedPipeCapture {
    pub fn new(path: &PathBuf) -> (Self, Arc<AtomicBool>) {
        create_named_pipe(path).unwrap();

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

pub enum FFmpegOutput {
    File {
        path: PathBuf,
        codec: String,
        preset: String,
        crf: u32,
    },
    RawVideo {
        format: String,
        width: u32,
        height: u32,
    },
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
            .args(["-f", "rawvideo", "-pix_fmt", self.pix_fmt])
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

impl Default for FFmpeg {
    fn default() -> Self {
        Self::new()
    }
}

impl FFmpeg {
    pub fn new() -> Self {
        let ffmpeg_binary_path_str = ffmpeg_path_as_str().unwrap().to_owned();

        Self {
            command: Command::new(ffmpeg_binary_path_str),
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

    pub fn add_output(&mut self, output: FFmpegOutput) {
        match output {
            FFmpegOutput::File {
                path,
                codec,
                preset,
                crf,
            } => {
                self.command
                    .arg("-i")
                    .arg("pipe:0")
                    .args(["-c:v", &codec])
                    .args(["-preset", &preset])
                    .args(["-crf", &crf.to_string()])
                    .arg(path);
            }
            FFmpegOutput::RawVideo {
                format,
                width,
                height,
            } => {
                self.command
                    .arg("-i")
                    .arg("pipe:0")
                    .args(["-f", &format])
                    .args(["-s", &format!("{}x{}", width, height)])
                    .arg("pipe:1");
            }
        }
    }

    pub fn start(self) -> FFmpegProcess {
        FFmpegProcess::spawn(self.command)
    }
}

pub fn handle_ffmpeg_installation() -> Result<(), String> {
    if ffmpeg_is_installed() {
        return Ok(());
    }

    match check_latest_version() {
        Ok(version) => println!("Latest available version: {}", version),
        Err(e) => println!("Skipping version check due to error: {e}"),
    }

    let download_url = ffmpeg_download_url().map_err(|e| e.to_string())?;
    let destination = sidecar_dir().map_err(|e| e.to_string())?;

    let archive_path =
        download_ffmpeg_package(download_url, &destination).map_err(|e| e.to_string())?;

    unpack_ffmpeg(&archive_path, &destination).map_err(|e| e.to_string())?;

    let version = ffmpeg_version().map_err(|e| e.to_string())?;

    println!("Done! Installed FFmpeg version {} 🏁", version);

    Ok(())
}
