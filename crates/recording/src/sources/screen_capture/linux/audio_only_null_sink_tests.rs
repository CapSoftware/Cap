use crate::{
    feeds::microphone::synthetic::SyntheticMicrophone,
    sources::screen_capture::ScreenCaptureTarget, studio_recording::Actor,
};
use cap_project::StudioRecordingStatus;
use std::{
    path::{Path, PathBuf},
    process::Command,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    thread::JoinHandle,
    time::Duration,
};

fn pulse_lock() -> &'static tokio::sync::Mutex<()> {
    static LOCK: std::sync::OnceLock<tokio::sync::Mutex<()>> = std::sync::OnceLock::new();
    LOCK.get_or_init(|| tokio::sync::Mutex::new(()))
}

fn module_ids(name: &str) -> Vec<String> {
    pactl(&["list", "short", "modules"])
        .lines()
        .filter_map(|line| {
            let mut fields = line.split_whitespace();
            let id = fields.next()?;
            let module = fields.next()?;
            (module == name).then(|| id.to_string())
        })
        .collect()
}

fn unload_module(name: &str) {
    for id in module_ids(name) {
        let _ = Command::new("pactl").args(["unload-module", &id]).output();
    }
}

struct NoPulseMonitor;

impl NoPulseMonitor {
    fn enforce() -> Self {
        unload_module("module-always-sink");
        unload_module("module-null-sink");
        Self
    }
}

impl Drop for NoPulseMonitor {
    fn drop(&mut self) {
        let _ = Command::new("pactl")
            .args(["load-module", "module-always-sink"])
            .output();
    }
}

fn pactl(args: &[&str]) -> String {
    let output = Command::new("pactl")
        .args(args)
        .output()
        .unwrap_or_else(|error| panic!("pactl {args:?} failed to start: {error}"));
    assert!(
        output.status.success(),
        "pactl {args:?} failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8_lossy(&output.stdout).trim().to_string()
}

struct NullSink {
    module: String,
    name: String,
}

impl NullSink {
    fn start(name: &str) -> Self {
        let module = pactl(&[
            "load-module",
            "module-null-sink",
            &format!("sink_name={name}"),
            &format!("sink_properties=device.description={name}"),
        ]);
        pactl(&["set-default-sink", name]);
        pactl(&["set-default-source", &format!("{name}.monitor")]);
        Self {
            module,
            name: name.to_string(),
        }
    }

    fn reload(&mut self) {
        pactl(&["unload-module", &self.module]);
        self.module = pactl(&[
            "load-module",
            "module-null-sink",
            &format!("sink_name={}", self.name),
            &format!("sink_properties=device.description={}", self.name),
        ]);
        pactl(&["set-default-sink", &self.name]);
        pactl(&["set-default-source", &format!("{}.monitor", self.name)]);
    }

    fn unload(&mut self) {
        if self.module.is_empty() {
            return;
        }
        let module = std::mem::take(&mut self.module);
        let _ = Command::new("pactl")
            .args(["unload-module", &module])
            .output();
    }
}

impl Drop for NullSink {
    fn drop(&mut self) {
        self.unload();
    }
}

struct Tone {
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

impl Tone {
    fn start(device: &str, wav: PathBuf) -> Self {
        let stop = Arc::new(AtomicBool::new(false));
        let thread = std::thread::spawn({
            let stop = stop.clone();
            let device = device.to_string();
            move || {
                while !stop.load(Ordering::Relaxed) {
                    let _ = Command::new("paplay")
                        .args(["--device", &device, &wav.to_string_lossy()])
                        .status();
                }
            }
        });
        Self {
            stop,
            thread: Some(thread),
        }
    }

    fn stop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

impl Drop for Tone {
    fn drop(&mut self) {
        self.stop();
    }
}

fn sine_wav(path: &Path, frequency: u32) {
    let status = Command::new("ffmpeg")
        .args([
            "-y",
            "-hide_banner",
            "-loglevel",
            "error",
            "-f",
            "lavfi",
            "-i",
            &format!("sine=frequency={frequency}:sample_rate=48000:duration=0.4"),
            "-c:a",
            "pcm_s16le",
            &path.to_string_lossy(),
        ])
        .status()
        .expect("ffmpeg");
    assert!(status.success(), "ffmpeg could not write the test tone");
}

fn decode_f32_mono(path: &Path) -> Vec<f32> {
    let output = Command::new("ffmpeg")
        .args([
            "-v",
            "error",
            "-i",
            &path.to_string_lossy(),
            "-ac",
            "1",
            "-ar",
            "48000",
            "-f",
            "f32le",
            "-",
        ])
        .output()
        .expect("ffmpeg");
    assert!(
        output.status.success(),
        "{} did not decode: {}",
        path.display(),
        String::from_utf8_lossy(&output.stderr)
    );
    output
        .stdout
        .chunks_exact(4)
        .map(|sample| f32::from_le_bytes(sample.try_into().expect("f32")))
        .collect()
}

fn tone_power(pcm: &[f32], frequency: f32) -> f32 {
    let sample_rate = 48_000.0;
    let omega = std::f32::consts::TAU * frequency / sample_rate;
    let coeff = 2.0 * omega.cos();
    let mut first = 0.0;
    let mut second = 0.0;
    for &sample in pcm {
        let next = sample + coeff * first - second;
        second = first;
        first = next;
    }
    first * first + second * second - coeff * first * second
}

fn assert_tail_is_frequency(path: &Path, frequency: f32) {
    let pcm = decode_f32_mono(path);
    let tail_samples = (48_000.0 * 0.4) as usize;
    assert!(
        pcm.len() > tail_samples + (48_000.0 * 0.3) as usize,
        "system audio is too short to contain audio from after the reload ({})",
        pcm.len()
    );
    let tail = &pcm[pcm.len() - tail_samples..];
    let wanted = tone_power(tail, frequency);
    let other = tone_power(tail, if frequency == 880.0 { 440.0 } else { 880.0 });
    assert!(
        wanted > other * 4.0 && wanted > 1.0,
        "the end of {} is not {frequency} Hz (wanted={wanted}, other={other})",
        path.display()
    );
}

fn playable_seconds(path: &Path) -> f64 {
    let decoded = Command::new("ffmpeg")
        .args([
            "-v",
            "error",
            "-i",
            &path.to_string_lossy(),
            "-f",
            "null",
            "-",
        ])
        .status()
        .expect("ffmpeg");
    assert!(
        decoded.success(),
        "{} did not decode to the end",
        path.display()
    );
    let output = Command::new("ffprobe")
        .args([
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "csv=p=0",
            &path.to_string_lossy(),
        ])
        .output()
        .expect("ffprobe");
    assert!(
        output.status.success(),
        "{} is not playable: {}",
        path.display(),
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8_lossy(&output.stdout)
        .trim()
        .parse()
        .unwrap_or_else(|_| panic!("{} has no duration", path.display()))
}

async fn push_mic(mic: &SyntheticMicrophone) {
    let samples = vec![0.2_f32; 4_800];
    mic.push(
        &samples,
        cap_timestamp::Timestamp::Instant(std::time::Instant::now()),
    )
    .await;
}

fn segment_file(project: &Path, name: &str) -> PathBuf {
    project.join(format!("content/segments/segment-0/{name}"))
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "PulseAudio null sink"]
async fn unloading_a_null_monitor_ends_audio_only_and_keeps_the_mic() {
    let _guard = pulse_lock().lock().await;
    pactl(&["info"]);
    let sink = NullSink::start("cap_loss_permanent");
    let temp = tempfile::tempdir().unwrap();
    let wav = temp.path().join("tone.wav");
    sine_wav(&wav, 440);
    let mut tone = Tone::start(&sink.name, wav);
    tokio::time::sleep(Duration::from_millis(300)).await;
    let mic = SyntheticMicrophone::spawn("test-mic", 48_000, 1);
    let project = temp.path().join("project");
    let handle = Actor::builder(project.clone(), ScreenCaptureTarget::AudioOnly)
        .with_system_audio(true)
        .with_mic_feed(Arc::new(mic.lock().await.unwrap()))
        .build()
        .await
        .expect("audio-only recording did not start against the null sink");
    let mic_stop = Arc::new(AtomicBool::new(false));
    let mic_pump = tokio::spawn({
        let mic_stop = mic_stop.clone();
        async move {
            while !mic_stop.load(Ordering::Relaxed) {
                push_mic(&mic).await;
                tokio::time::sleep(Duration::from_millis(80)).await;
            }
        }
    });
    tokio::time::sleep(Duration::from_millis(700)).await;
    tone.stop();
    let _no_monitor = NoPulseMonitor::enforce();
    drop(sink);
    let sources = pactl(&["list", "short", "sources"]);
    assert!(
        !sources.contains(".monitor"),
        "a monitor was still available after unload:\n{sources}"
    );
    let outcome = tokio::time::timeout(Duration::from_secs(12), handle.done_fut())
        .await
        .unwrap_or_else(|_| {
            panic!(
                "unloading the monitor left the audio-only take running; sources:\n{}",
                pactl(&["list", "short", "sources"])
            )
        });
    outcome.expect("unloading the monitor failed the take");
    tokio::time::sleep(Duration::from_millis(200)).await;
    mic_stop.store(true, Ordering::Relaxed);
    mic_pump.abort();
    let stop_result = tokio::time::timeout(Duration::from_secs(20), handle.stop())
        .await
        .expect("stop hung after the monitor was unloaded");
    assert_saved_audio(&project, &stop_result, true);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "PulseAudio null sink"]
async fn reloading_a_null_monitor_keeps_audio_only_running() {
    let _guard = pulse_lock().lock().await;
    pactl(&["info"]);
    let _only_this_sink = NoPulseMonitor::enforce();
    let mut sink = NullSink::start("cap_loss_transient");
    let temp = tempfile::tempdir().unwrap();
    let before = temp.path().join("tone-440.wav");
    let after = temp.path().join("tone-880.wav");
    sine_wav(&before, 440);
    sine_wav(&after, 880);
    let mut tone = Tone::start(&sink.name, before);
    tokio::time::sleep(Duration::from_millis(300)).await;
    let project = temp.path().join("project");
    let handle = Actor::builder(project.clone(), ScreenCaptureTarget::AudioOnly)
        .with_system_audio(true)
        .build()
        .await
        .expect("audio-only recording did not start against the null sink");
    tokio::time::sleep(Duration::from_millis(500)).await;
    tone.stop();
    sink.reload();
    let mut tone = Tone::start(&sink.name, after);
    tokio::time::sleep(Duration::from_millis(1500)).await;
    let still_running = tokio::time::timeout(Duration::from_secs(4), handle.done_fut()).await;
    assert!(
        still_running.is_err(),
        "reloading the monitor ended the take: {still_running:?}"
    );
    tone.stop();
    let stop_result = tokio::time::timeout(Duration::from_secs(20), handle.stop())
        .await
        .expect("stop hung after the monitor was reloaded");
    assert_saved_audio(&project, &stop_result, false);
    assert_tail_is_frequency(&segment_file(&project, "system_audio.m4a"), 880.0);
}

fn assert_saved_audio(
    project: &Path,
    stop_result: &anyhow::Result<crate::studio_recording::CompletedRecording>,
    expect_mic: bool,
) {
    match stop_result {
        Ok(completed) => assert!(
            matches!(completed.meta.status(), StudioRecordingStatus::Complete),
            "saved status was {:?}",
            completed.meta.status()
        ),
        Err(error) => {
            let message = format!("{error:#}");
            assert!(
                message.contains("audio-only display track") && message.contains("Codec not found"),
                "stop failed: {message}"
            );
        }
    }
    let system = segment_file(project, "system_audio.m4a");
    assert!(
        playable_seconds(&system) > 0.05,
        "system audio file did not play"
    );
    if expect_mic {
        let microphone = segment_file(project, "audio-input.m4a");
        assert!(
            playable_seconds(&microphone) > 0.05,
            "mic audio was dropped when the monitor was unloaded"
        );
    }
}
