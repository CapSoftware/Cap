use std::{io::Cursor, sync::mpsc, time::Duration};

use cap_recording::RecordingStartGate;
use rodio::{Decoder, OutputStream, Sink};

// The cue is under half a second; a device that has not finished it by now
// (route change mid-countdown, stalled engine) must not hold the recording back.
const PLAYBACK_TIMEOUT: Duration = Duration::from_millis(1500);
const CANCEL_POLL_INTERVAL: Duration = Duration::from_millis(5);
// Rodio reports an empty sink once the mixer has consumed the last sample; that
// buffer still has to play out through the device before the cue is audibly
// done. Shared-mode WASAPI and PulseAudio devices commonly sit at 30-100ms, so
// err towards the cue preceding capture rather than landing inside it.
const FALLBACK_OUTPUT_LATENCY: Duration = Duration::from_millis(150);

struct PlayCommand {
    gate: RecordingStartGate,
    done: tokio::sync::oneshot::Sender<Result<(), String>>,
}

impl PlayCommand {
    fn cancelled(&self) -> bool {
        self.done.is_closed()
    }

    fn finish(self, result: Result<(), String>) {
        if result.is_ok() {
            self.gate.arm();
        }
        let _ = self.done.send(result);
    }
}

/// An output device opened ahead of the start cue so `play` begins instantly.
/// Dropping it unused releases the device.
pub struct StartCue {
    command: mpsc::Sender<PlayCommand>,
}

impl StartCue {
    #[cfg(test)]
    fn stub() -> (Self, mpsc::Receiver<PlayCommand>) {
        let (command, rx) = mpsc::channel();
        (Self { command }, rx)
    }
}

pub fn prime(bytes: &'static [u8]) -> StartCue {
    let (command, rx) = mpsc::channel();
    if let Err(error) = std::thread::Builder::new()
        .name("recording-start-sound".into())
        .spawn(move || worker(bytes, rx))
    {
        tracing::warn!(%error, "Could not start recording sound worker");
    }
    StartCue { command }
}

fn worker(bytes: &'static [u8], rx: mpsc::Receiver<PlayCommand>) {
    #[cfg(target_os = "macos")]
    match native::Output::prepare(bytes) {
        Ok(output) => return output.run(rx),
        Err(error) => tracing::warn!(%error, "Native start sound unavailable; using fallback"),
    }
    fallback::run(bytes, rx);
}

/// Plays the start cue and arms `gate` the instant its last sample has left the
/// output device. The gate is always armed before this returns, including when
/// playback fails, times out, or the future is dropped mid-cue.
pub async fn play(cue: StartCue, gate: RecordingStartGate) {
    play_with_timeout(cue, gate, PLAYBACK_TIMEOUT).await;
}

async fn play_with_timeout(cue: StartCue, gate: RecordingStartGate, timeout: Duration) {
    let _arm_on_drop = ArmOnDrop(gate.clone());
    let (done, done_rx) = tokio::sync::oneshot::channel();
    if cue.command.send(PlayCommand { gate, done }).is_err() {
        tracing::warn!("Recording start sound worker is not running");
        return;
    }
    match tokio::time::timeout(timeout, done_rx).await {
        Ok(Ok(Ok(()))) => {}
        Ok(Ok(Err(error))) => tracing::warn!(%error, "Recording start sound unavailable"),
        Ok(Err(_)) => tracing::warn!("Recording start sound worker stopped"),
        Err(_) => tracing::warn!("Recording start sound timed out"),
    }
}

struct ArmOnDrop(RecordingStartGate);

impl Drop for ArmOnDrop {
    fn drop(&mut self) {
        self.0.arm();
    }
}

mod fallback {
    use super::*;

    pub fn run(bytes: &'static [u8], rx: mpsc::Receiver<PlayCommand>) {
        let output = OutputStream::try_default()
            .map_err(|error| error.to_string())
            .and_then(|(stream, handle)| {
                let sink = Sink::try_new(&handle).map_err(|error| error.to_string())?;
                let source = Decoder::new(Cursor::new(bytes)).map_err(|error| error.to_string())?;
                Ok((stream, sink, source))
            });
        let Ok(command) = rx.recv() else {
            return;
        };
        let (_stream, sink, source) = match output {
            Ok(output) => output,
            Err(error) => return command.finish(Err(error)),
        };
        let started = std::time::Instant::now();
        sink.append(source);
        tracing::info!("Recording start cue playing");
        while !sink.empty() {
            if command.cancelled() {
                sink.stop();
                return;
            }
            std::thread::sleep(CANCEL_POLL_INTERVAL);
        }
        std::thread::sleep(FALLBACK_OUTPUT_LATENCY);
        tracing::info!(
            played_back_after_ms = started.elapsed().as_millis() as u64,
            "Recording start cue finished"
        );
        command.finish(Ok(()));
    }
}

#[cfg(target_os = "macos")]
mod native {
    use super::*;
    use cidre::{av, blocks, objc};
    use rodio::Source;

    trait PlayedBackScheduling: objc::Obj {
        #[objc::msg_send(scheduleBuffer:completionCallbackType:completionHandler:)]
        fn schedule_played_back(
            &self,
            buffer: &av::AudioPcmBuf,
            callback_type: av::audio::PlayerNodeCompletionCbType,
            callback: &mut blocks::EscBlock<fn(av::audio::PlayerNodeCompletionCbType)>,
        );
    }

    impl PlayedBackScheduling for av::AudioPlayerNode {}

    pub struct Output {
        engine: cidre::arc::R<av::AudioEngine>,
        player: cidre::arc::R<av::AudioPlayerNode>,
        buffer: cidre::arc::R<av::AudioPcmBuf>,
        sample_rate: u64,
    }

    impl Drop for Output {
        fn drop(&mut self) {
            let _ = objc::try_catch(|| {
                self.player.stop();
                self.engine.stop();
            });
        }
    }

    impl Output {
        pub fn prepare(bytes: &'static [u8]) -> Result<Self, String> {
            objc::try_catch(|| Self::prepare_inner(bytes))
                .map_err(|error| format!("Start sound output exception: {error:?}"))?
        }

        fn prepare_inner(bytes: &'static [u8]) -> Result<Self, String> {
            let source = Decoder::new(Cursor::new(bytes)).map_err(|error| error.to_string())?;
            let channels = usize::from(source.channels());
            let rate = source.sample_rate();
            let samples: Vec<i16> = source.collect();
            let frames =
                u32::try_from(samples.len() / channels).map_err(|error| error.to_string())?;
            let format = av::AudioFormat::standard_with_sample_rate_and_channels(
                f64::from(rate),
                channels as u32,
            )
            .ok_or("Could not create start sound format")?;
            let mut buffer = av::AudioPcmBuf::with_format(&format, frames)
                .ok_or("Could not create start sound buffer")?;
            buffer
                .set_frame_len(frames)
                .map_err(|error| format!("{error:?}"))?;
            for channel in 0..channels {
                let target = buffer
                    .data_f32_mut_at(channel)
                    .ok_or("Could not access start sound samples")?;
                for (frame, sample) in target.iter_mut().enumerate() {
                    *sample = f32::from(samples[frame * channels + channel]) / 32768.0;
                }
            }

            let mut output = Output {
                engine: av::AudioEngine::new(),
                player: av::AudioPlayerNode::new(),
                buffer,
                sample_rate: u64::from(rate),
            };
            output.engine.attach_node(&output.player);
            let mixer = output.engine.main_mixer_node().retained();
            output
                .engine
                .connect_node_to_node(&output.player, &mixer, Some(&format));
            output.engine.prepare();
            output
                .engine
                .start()
                .map_err(|error| format!("{error:?}"))?;
            Ok(output)
        }

        pub fn run(self, rx: mpsc::Receiver<PlayCommand>) {
            let Ok(command) = rx.recv() else {
                return;
            };
            let result = objc::try_catch(|| self.play(&command))
                .map_err(|error| format!("Start sound playback exception: {error:?}"))
                .and_then(|result| result);
            match result {
                Ok(true) => command.finish(Ok(())),
                Ok(false) => {}
                Err(error) => command.finish(Err(error)),
            }
        }

        fn play(&self, command: &PlayCommand) -> Result<bool, String> {
            let (sender, receiver) = mpsc::channel();
            let gate = command.gate.clone();
            let started = std::time::Instant::now();
            let mut callback = blocks::EscBlock::new1(move |kind| {
                if kind == av::audio::PlayerNodeCompletionCbType::DataPlayedBack {
                    gate.arm();
                    tracing::info!(
                        played_back_after_ms = started.elapsed().as_millis() as u64,
                        "Recording start cue finished"
                    );
                }
                let _ = sender.send(kind);
            });
            self.player.schedule_played_back(
                &self.buffer,
                av::audio::PlayerNodeCompletionCbType::DataPlayedBack,
                &mut callback,
            );
            self.player.play();
            tracing::info!(
                buffer_ms = self.buffer.frame_len() as u64 * 1000 / self.sample_rate.max(1),
                "Recording start cue playing"
            );
            loop {
                if command.cancelled() {
                    self.player.stop();
                    return Ok(false);
                }
                match receiver.recv_timeout(CANCEL_POLL_INTERVAL) {
                    Ok(av::audio::PlayerNodeCompletionCbType::DataPlayedBack) => return Ok(true),
                    Ok(_) => return Err("Unexpected start sound completion".into()),
                    Err(mpsc::RecvTimeoutError::Timeout) => {}
                    Err(mpsc::RecvTimeoutError::Disconnected) => {
                        return Err("Start sound completion disconnected".into());
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn successful_playback_arms_the_gate_from_the_worker() {
        let (cue, rx) = StartCue::stub();
        let gate = RecordingStartGate::new();
        let playback = tokio::spawn(play(cue, gate.clone()));
        let command = tokio::task::spawn_blocking(move || rx.recv().unwrap())
            .await
            .unwrap();
        assert!(!gate.is_armed());
        command.finish(Ok(()));
        assert!(gate.is_armed());
        playback.await.unwrap();
    }

    #[tokio::test]
    async fn failed_playback_still_arms_the_gate() {
        let (cue, rx) = StartCue::stub();
        let gate = RecordingStartGate::new();
        let playback = tokio::spawn(play(cue, gate.clone()));
        let command = tokio::task::spawn_blocking(move || rx.recv().unwrap())
            .await
            .unwrap();
        command.finish(Err("No audio output device".into()));
        playback.await.unwrap();
        assert!(gate.is_armed());
    }

    #[tokio::test]
    async fn timed_out_playback_arms_the_gate() {
        let (cue, rx) = StartCue::stub();
        let gate = RecordingStartGate::new();
        play_with_timeout(cue, gate.clone(), Duration::from_millis(20)).await;
        assert!(gate.is_armed());
        assert!(rx.recv().unwrap().cancelled());
    }

    #[tokio::test]
    async fn dropping_playback_arms_the_gate_and_cancels_the_worker() {
        let (cue, rx) = StartCue::stub();
        let gate = RecordingStartGate::new();
        let playback = tokio::spawn(play(cue, gate.clone()));
        let command = tokio::task::spawn_blocking(move || rx.recv().unwrap())
            .await
            .unwrap();
        assert!(!command.cancelled());
        playback.abort();
        assert!(playback.await.unwrap_err().is_cancelled());
        assert!(gate.is_armed());
        assert!(command.cancelled());
    }

    #[tokio::test]
    async fn missing_worker_arms_the_gate() {
        let (cue, rx) = StartCue::stub();
        drop(rx);
        let gate = RecordingStartGate::new();
        play(cue, gate.clone()).await;
        assert!(gate.is_armed());
    }
}
