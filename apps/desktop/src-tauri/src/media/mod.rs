use std::{
    path::{Path, PathBuf},
    process::Stdio,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};
use scap::capturer::Resolution;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::Mutex;
use tokio::task::JoinHandle;
use tracing::Level;

use crate::{
    app::config,
    recording::RecordingOptions,
    utils::{create_named_pipe, ffmpeg_path_as_str},
};

mod audio;
mod video;

use audio::AudioCapturer;
use video::VideoCapturer;

type SharedInstant = Arc<Mutex<Option<Instant>>>;

struct SharedFlag(Arc<AtomicBool>);

impl Default for SharedFlag {
    fn default() -> Self {
        Self::new(false)
    }
}

impl SharedFlag {
    fn new(value: bool) -> Self {
        Self(Arc::new(AtomicBool::new(value)))
    }

    fn get(&self) -> bool {
        self.0.load(Ordering::SeqCst)
    }

    fn set(&self, value: bool) {
        self.0.store(value, Ordering::SeqCst);
    }

    fn clone(&self) -> Self {
        Self(Arc::clone(&self.0))
    }
}

#[derive(Default)]
pub struct MediaRecorder {
    pub options: Option<RecordingOptions>,
    audio_capturer: Option<AudioCapturer>,
    audio_enabled: bool,
    // video_capturer: Option<VideoCapturer>,
    should_stop: SharedFlag,
    ffmpeg_process: Option<Child>,
    // ffmpeg_stdin: Option<Arc<Mutex<Option<ChildStdin>>>>,
    ffmpeg_stdin: Option<ChildStdin>,
    device_name: Option<String>,
    start_time: Option<Instant>,
    chunks_dir: PathBuf,
    audio_pipe_task: Option<JoinHandle<()>>,
    video_pipe_task: Option<JoinHandle<()>>,
}

impl MediaRecorder {
    pub fn new() -> Self {
        Self::default()
    }

    #[tracing::instrument(skip(self))]
    pub async fn start_media_recording(
        &mut self,
        options: RecordingOptions,
        screenshot_dir: &Path,
        recording_dir: &Path,
        custom_device: Option<&str>,
        max_screen_width: usize,
        max_screen_height: usize,
        video_resolution: Resolution,
    ) -> Result<(), String> {
        if !scap::has_permission() {
            tracing::warn!("Screen capturing permission not granted. Requesting permission...");
            scap::request_permission();
            return Err("App does not have screen capturing permission".into());
        }

        let options_clone = options.clone();
        self.options = Some(options);

        // let adjusted_width = max_screen_width & !2;
        // let adjusted_height = max_screen_height & !2;

        let ffmpeg_binary_path_str = ffmpeg_path_as_str().unwrap().to_owned();

        let audio_start_time: SharedInstant = Arc::new(Mutex::new(None));
        let video_start_time: SharedInstant = Arc::new(Mutex::new(None));

        self.audio_capturer = AudioCapturer::init(custom_device, self.should_stop.clone());

        let mut video_capturer = VideoCapturer::new(
            max_screen_width,
            max_screen_height,
            video_resolution,
            self.should_stop.clone(),
        );
        let adjusted_width = video_capturer.frame_width;
        let adjusted_height = video_capturer.frame_height;

        if let Some(ref mut audio_capturer) = self.audio_capturer {
            audio_capturer.log_info();

            match audio_capturer.start(audio_start_time.clone()) {
                Ok(_) => {
                    self.audio_enabled = true;
                }
                Err(error) => tracing::error!(error),
            }
        }

        video_capturer.start(video_start_time.clone(), screenshot_dir, options_clone);

        tracing::info!("Starting audio recording and processing...");
        let segment_pattern_path = recording_dir.join("segment_%03d.ts");
        let playlist_path = recording_dir.join("stream.m3u8");

        let video_pipe_path = recording_dir.join("video.pipe");

        std::fs::remove_file(&video_pipe_path).ok();
        create_named_pipe(&video_pipe_path).map_err(|e| e.to_string())?;

        let audio_pipe_path = recording_dir.join("audio.pipe");

        std::fs::remove_file(&audio_pipe_path).ok();
        create_named_pipe(&audio_pipe_path).map_err(|e| e.to_string())?;

        let time_offset = if self.audio_enabled {
            tracing::trace!("Adjusting FFmpeg commands based on start times...");
            create_time_offset_args(&audio_start_time, &video_start_time).await
        } else {
            None
        };

        let size = format!("{}x{}", adjusted_width, adjusted_height);

        let mut ffmpeg_command = Command::new(ffmpeg_binary_path_str);

        // Quiet ffmpeg output a bit
        let log_level = config::logging_level();
        if log_level == Level::DEBUG || log_level == Level::TRACE {
            ffmpeg_command.args(["-nostats", "-hide_banner"]);
        }
        if let Some((TimeOffsetTarget::Video, args)) = &time_offset {
            ffmpeg_command.args(args);
        }

        let fps = VideoCapturer::FPS.to_string();
        ffmpeg_command
            // video in
            .args(["-f", "rawvideo", "-pix_fmt", "bgra"])
            .args(["-s", &size, "-r", &fps])
            .args(["-thread_queue_size", "4096", "-i"])
            .arg(&video_pipe_path);

        if self.audio_enabled {
            if let Some((TimeOffsetTarget::Audio, args)) = &time_offset {
                ffmpeg_command.args(args);
            }

            let capturer = self.audio_capturer.as_ref().unwrap();
            let sample_format = capturer.sample_format();
            let sample_rate_str = capturer.sample_rate().to_string();
            let channels_str = capturer.channels().to_string();

            ffmpeg_command
                // audio in
                .args(["-f", sample_format, "-ar", &sample_rate_str])
                .args(["-ac", &channels_str, "-thread_queue_size", "4096", "-i"])
                .arg(&audio_pipe_path);
            // out
            // .args(["-f", "hls", "-async", "1"])
            // .args(["-segment_time", "3", "-segment_time_delta", "0.01"])
            // .args(["-reset_timestamps", "1", "-vn", "-segment_list"])
            // .args([&audio_segment_list_filename, &audio_chunk_pattern]);
        }

        ffmpeg_command
            .args(["-f", "hls"])
            .args(["-hls_time", "3", "-hls_playlist_type", "vod"])
            .args(["-hls_flags", "independent_segments"])
            .args(["-master_pl_name", "master.m3u8"])
            .args(["-hls_segment_type", "mpegts"])
            .arg("-hls_segment_filename")
            .arg(&segment_pattern_path)
            // video
            .args(["-codec:v", "libx264", "-preset", "ultrafast"])
            .args(["-pix_fmt", "yuv420p", "-tune", "zerolatency"])
            .args(["-vsync", "1", "-force_key_frames", "expr:gte(t,n_forced*3)"])
            .args(["-movflags", "frag_keyframe+empty_moov"])
            .args([
                "-vf",
                &format!("fps={fps},scale=in_range=full:out_range=limited"),
            ]);

        if self.audio_enabled {
            ffmpeg_command
                // audio
                .args(["-codec:a", "aac", "-b:a", "128k", "-async", "1"])
                .args([
                    "-af",
                    "aresample=async=1:min_hard_comp=0.100000:first_pts=0",
                ]);
        } else {
            ffmpeg_command.args(["-an"]);
        }

        ffmpeg_command.arg(&playlist_path);

        tracing::trace!("Starting FFmpeg process...");

        let (ffmpeg_child, ffmpeg_stdin) = self
            .start_ffmpeg_process(ffmpeg_command)
            .await
            .map_err(|e| e.to_string())?;
        tracing::trace!("Ffmpeg process started");

        if self.audio_enabled {
            let capturer = self.audio_capturer.as_mut().unwrap();
            self.audio_pipe_task = Some(tokio::spawn(capturer.collect_samples(audio_pipe_path)));
        }

        self.video_pipe_task = Some(tokio::spawn(video_capturer.collect_frames(video_pipe_path)));

        self.start_time = Some(Instant::now());
        self.chunks_dir = recording_dir.to_path_buf();
        self.ffmpeg_process = Some(ffmpeg_child);
        self.ffmpeg_stdin = Some(ffmpeg_stdin);
        self.device_name = self.audio_capturer.as_ref().map(|c| c.device_name.clone());

        tracing::info!("Media recording successfully started");

        Ok(())
    }

    /// The order of operations in this function is important!! Letting the tasks
    /// that pipe collected audio/video into FFmpeg gracefully shut down first allows
    /// us to close the ffmpeg process (and kill the cpal stream) with impunity.
    #[tracing::instrument(skip(self))]
    pub async fn stop_media_recording(&mut self) -> Result<(), String> {
        self.should_stop.set(true);

        if self.audio_enabled {
            if let Some(ref mut audio_task) = self.audio_pipe_task {
                audio_task.await.map_err(|error| error.to_string())?;
                tracing::info!("Audio recording stopped");
            }

            if let Some(ref mut audio_capturer) = self.audio_capturer {
                audio_capturer.stop()?;
            }
        }

        if let Some(ref mut video_task) = self.video_pipe_task {
            video_task.await.map_err(|error| error.to_string())?;
            tracing::info!("Video capturing stopped");
        }

        if let Some(ref mut stdin) = self.ffmpeg_stdin {
            tracing::info!("Shutting down recording");
            stdin.shutdown().await.map_err(|e| e.to_string())?;
        }

        if let Some(mut process) = self.ffmpeg_process.take() {
            tracing::info!("Writing remaining segments to disk...");
            loop {
                match process.try_wait() {
                    Ok(Some(_)) => {
                        tracing::info!("Successfully written all segments to disk");
                        break;
                    }
                    Ok(None) => {
                        tokio::time::sleep(Duration::from_millis(300)).await;
                    }
                    Err(error) => {
                        tracing::error!("Couldn't check on FFmpeg process");
                        return Err(error.to_string());
                    }
                }
            }
        }

        tracing::info!("All recording stopped.");
        Ok(())
    }

    async fn start_ffmpeg_process(
        &self,
        cmd: Command,
    ) -> Result<(Child, ChildStdin), std::io::Error> {
        let mut video_process = start_recording_process(cmd).await.map_err(|e| {
            tracing::error!("Failed to start video recording process: {}", e);
            std::io::Error::new(std::io::ErrorKind::Other, e.to_string())
        })?;

        let video_stdin = video_process.stdin.take().ok_or_else(|| {
            tracing::error!("Failed to take video stdin");
            std::io::Error::new(std::io::ErrorKind::Other, "Failed to take video stdin")
        })?;

        Ok((video_process, video_stdin))
    }
}

#[tauri::command]
#[specta::specta]
#[tracing::instrument]
pub fn enumerate_audio_devices() -> Vec<String> {
    let devices = audio::get_input_devices();

    devices.keys().cloned().collect()
}

#[tracing::instrument]
async fn start_recording_process(
    mut cmd: Command,
) -> Result<tokio::process::Child, std::io::Error> {
    let mut process = cmd.stdin(Stdio::piped()).stderr(Stdio::piped()).spawn()?;

    if let Some(process_stderr) = process.stderr.take() {
        tokio::spawn(async move {
            let mut process_reader = BufReader::new(process_stderr).lines();
            while let Ok(Some(line)) = process_reader.next_line().await {
                // TODO: Replace with ingesting the output of ffmpeg's -process flag and reserve this for actual errors?
                tracing::info!("FFmpeg process: {}", line);
            }
        });
    }

    Ok(process)
}

#[tracing::instrument]
async fn wait_for_start_times(
    audio_start_time: &Mutex<Option<Instant>>,
    video_start_time: &Mutex<Option<Instant>>,
) -> (Instant, Instant) {
    loop {
        let audio_start_locked = audio_start_time.lock().await;
        let video_start_locked = video_start_time.lock().await;

        if audio_start_locked.is_some() && video_start_locked.is_some() {
            let audio_start = *audio_start_locked.as_ref().unwrap();
            let video_start = *video_start_locked.as_ref().unwrap();
            return (audio_start, video_start);
        }
        drop(audio_start_locked);
        drop(video_start_locked);
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

pub enum TimeOffsetTarget {
    Audio,
    Video,
}

#[tracing::instrument]
async fn create_time_offset_args(
    audio_start_time: &Mutex<Option<Instant>>,
    video_start_time: &Mutex<Option<Instant>>,
) -> Option<(TimeOffsetTarget, Vec<String>)> {
    let (audio_start, video_start) = wait_for_start_times(audio_start_time, video_start_time).await;
    let duration_difference = if audio_start > video_start {
        audio_start.duration_since(video_start)
    } else {
        video_start.duration_since(audio_start)
    };

    tracing::debug!("Duration difference: {:?}", duration_difference);
    tracing::debug!("Audio start: {:?}", audio_start);
    tracing::debug!("Video start: {:?}", video_start);

    // Convert the duration difference to a float representing seconds
    let offset_seconds =
        (duration_difference.as_secs() as f64) + (duration_difference.subsec_nanos() as f64) * 1e-9;

    // Depending on which started first, adjust the relevant FFmpeg command
    if audio_start > video_start {
        // Offset the video start time
        tracing::info!("Applying -itsoffset {:.3} to video", offset_seconds);

        Some((
            TimeOffsetTarget::Video,
            vec!["-itsoffset".to_string(), format!("{:.3}", offset_seconds)],
        ))
    } else if video_start > audio_start {
        // Offset the audio start time
        tracing::info!("Applying -itsoffset {:.3} to audio", offset_seconds);

        Some((
            TimeOffsetTarget::Audio,
            vec!["-itsoffset".to_string(), format!("{:.3}", offset_seconds)],
        ))
    } else {
        None
    }
}
