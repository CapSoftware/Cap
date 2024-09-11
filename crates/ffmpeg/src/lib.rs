use cap_utils::create_named_pipe;
use std::{
    ffi::OsString,
    io::{Read, Write},
    ops::Deref,
    path::{Path, PathBuf},
    process::{Child, ChildStdin, Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};
use tauri::utils::platform;

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

#[derive(Debug, Default)]
pub struct FFmpegRawVideoInput {
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub pix_fmt: &'static str,
    pub input: OsString,
    // pub offset: f64,
}

impl ApplyFFmpegArgs for FFmpegRawVideoInput {
    fn apply_ffmpeg_args(&self, command: &mut Command) {
        dbg!(&self);
        let size = format!("{}x{}", self.width, self.height);

        command
            .args(["-f", "rawvideo", "-pix_fmt", self.pix_fmt])
            .args(["-s", &size]);

        if self.fps == 0 {
            command.args(["-use_wallclock_as_timestamps", "1"]);
        } else {
            command.args(["-r", &self.fps.to_string()]);
        }

        dbg!(PathBuf::from(&self.input).exists());

        // if self.offset != 0.0 {
        //     command.args(["-itsoffset", &self.offset.to_string()]);
        // }

        command
            .args(["-thread_queue_size", "4096", "-i"])
            .arg(&self.input);
    }
}

#[derive(Debug, Default)]
pub struct FFmpegRawAudioInput {
    pub sample_format: String,
    pub sample_rate: u32,
    pub channels: u16,
    pub input: OsString,
    pub wallclock: bool, // pub offset: f64,
}

impl ApplyFFmpegArgs for FFmpegRawAudioInput {
    fn apply_ffmpeg_args(&self, command: &mut Command) {
        dbg!(&self);
        command
            .args(["-f", &self.sample_format])
            .args(["-ar", &self.sample_rate.to_string()])
            .args(["-ac", &self.channels.to_string()]);

        if self.wallclock {
            command.args(["-use_wallclock_as_timestamps", "1"]);
        }

        // if self.offset != 0.0 {
        //     command.args(["-itsoffset", &self.offset.to_string()]);
        // }

        command.args(["-thread_queue_size", "4096", "-i"]);
        command.arg(&self.input);
    }
}

pub struct FFmpeg {
    pub command: Command,
    source_index: u8,
}

impl FFmpeg {
    pub fn new() -> Self {
        Self {
            command: Command::new(dbg!(relative_command_path("ffmpeg").unwrap())).into(),
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

fn relative_command_path(command: impl AsRef<Path>) -> Result<PathBuf, tauri_plugin_shell::Error> {
    match platform::current_exe()?.parent() {
        #[cfg(windows)]
        Some(exe_dir) => Ok(exe_dir.join(command.as_ref()).with_extension("exe")),
        #[cfg(not(windows))]
        Some(exe_dir) => Ok(exe_dir.join(command.as_ref())),
        None => Err(tauri_plugin_shell::Error::CurrentExeHasNoParent),
    }
}
