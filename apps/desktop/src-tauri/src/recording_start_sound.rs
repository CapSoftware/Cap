use std::{
    io::Cursor,
    sync::{Arc, Mutex},
    time::Duration,
};

use rodio::{Decoder, OutputStream, Sink, Source};

const PLAYBACK_TIMEOUT: Duration = Duration::from_secs(3);
const OUTPUT_SETTLING_TIME: Duration = Duration::from_millis(500);
static ACTIVE_WORKER: Mutex<Option<Arc<PlaybackControl>>> = Mutex::new(None);

pub fn should_play_countdown_sound(countdown: Option<u32>, visible: bool) -> bool {
    visible && countdown.is_some_and(|seconds| seconds > 1)
}

#[derive(Default)]
struct PlaybackState {
    cancelled: bool,
    started: bool,
    sink: Option<Arc<Sink>>,
}

#[derive(Default)]
struct PlaybackControl(Mutex<PlaybackState>);

impl PlaybackControl {
    fn start<S>(&self, sink: Arc<Sink>, source: S) -> bool
    where
        S: Source<Item = i16> + Send + 'static,
    {
        let mut state = self.0.lock().unwrap_or_else(|error| error.into_inner());
        if state.cancelled {
            return false;
        }
        sink.append(source);
        state.started = true;
        state.sink = Some(sink);
        true
    }

    #[cfg(target_os = "macos")]
    fn start_native(&self, start: impl FnOnce()) -> bool {
        let mut state = self.0.lock().unwrap_or_else(|error| error.into_inner());
        if state.cancelled {
            return false;
        }
        state.started = true;
        start();
        true
    }

    #[cfg(target_os = "macos")]
    fn started(&self) -> bool {
        self.0
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .started
    }

    fn cancelled(&self) -> bool {
        self.0
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .cancelled
    }

    fn cancel(&self) -> bool {
        let mut state = self.0.lock().unwrap_or_else(|error| error.into_inner());
        state.cancelled = true;
        if let Some(sink) = state.sink.take() {
            sink.stop();
        }
        std::mem::take(&mut state.started)
    }
}

struct CancelOnDrop(Arc<PlaybackControl>);

impl Drop for CancelOnDrop {
    fn drop(&mut self) {
        self.0.cancel();
    }
}

struct WorkerSlot;

impl Drop for WorkerSlot {
    fn drop(&mut self) {
        *ACTIVE_WORKER
            .lock()
            .unwrap_or_else(|error| error.into_inner()) = None;
    }
}

pub async fn play(bytes: &'static [u8]) {
    let control = {
        let mut active = ACTIVE_WORKER
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        match active.as_ref() {
            Some(control) => Err(control.clone()),
            None => {
                let control = Arc::new(PlaybackControl::default());
                *active = Some(control.clone());
                Ok(control)
            }
        }
    };
    let control = match control {
        Ok(control) => control,
        Err(control) => {
            tracing::warn!("Previous start sound worker is still stopping; skipping start sound");
            control.cancel();
            tokio::time::sleep(OUTPUT_SETTLING_TIME).await;
            return;
        }
    };
    let slot = WorkerSlot;
    play_with_worker(
        control,
        PLAYBACK_TIMEOUT,
        OUTPUT_SETTLING_TIME,
        move |control| {
            let _slot = slot;
            #[cfg(target_os = "macos")]
            match native::play(bytes, &control) {
                Ok(()) => return Ok(()),
                Err(error) if control.started() || control.cancelled() => return Err(error),
                Err(error) => {
                    tracing::warn!(%error, "Native start sound unavailable; using fallback")
                }
            }
            let (_stream, handle) =
                OutputStream::try_default().map_err(|error| error.to_string())?;
            let source = Decoder::new(Cursor::new(bytes)).map_err(|error| error.to_string())?;
            let sink = Arc::new(Sink::try_new(&handle).map_err(|error| error.to_string())?);
            if !control.start(sink.clone(), source) {
                return Ok(());
            }
            while !sink.empty() && !control.cancelled() {
                std::thread::sleep(Duration::from_millis(10));
            }
            // Rodio drains its queue before buffered output reaches the speakers.
            // Keep the stream alive through a quiet interval before admitting capture.
            std::thread::sleep(OUTPUT_SETTLING_TIME);
            Ok(())
        },
    )
    .await;
}

async fn play_with_worker(
    control: Arc<PlaybackControl>,
    timeout: Duration,
    settling_time: Duration,
    worker: impl FnOnce(Arc<PlaybackControl>) -> Result<(), String> + Send + 'static,
) {
    let _cancel_on_drop = CancelOnDrop(control.clone());
    let (sender, receiver) = tokio::sync::oneshot::channel();
    let worker_control = control.clone();
    if let Err(error) = std::thread::Builder::new()
        .name("recording-start-sound".into())
        .spawn(move || {
            let result = worker(worker_control);
            let _ = sender.send(result);
        })
    {
        tracing::warn!(%error, "Could not start recording sound worker");
        return;
    }

    let failed = match tokio::time::timeout(timeout, receiver).await {
        Ok(Ok(Ok(()))) => false,
        Ok(Ok(Err(error))) => {
            tracing::warn!(%error, "Recording start sound unavailable");
            true
        }
        Ok(Err(error)) => {
            tracing::warn!(%error, "Recording start sound worker stopped");
            true
        }
        Err(_) => {
            tracing::warn!("Recording start sound timed out");
            true
        }
    };
    if control.cancel() && failed {
        tokio::time::sleep(settling_time).await;
    }
}

#[cfg(target_os = "macos")]
mod native {
    use super::*;
    use cidre::{av, blocks, objc};
    use std::sync::mpsc;

    const ACOUSTIC_SETTLING_TIME: Duration = Duration::from_millis(100);

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

    struct Output {
        engine: cidre::arc::R<av::AudioEngine>,
        player: cidre::arc::R<av::AudioPlayerNode>,
    }

    impl Drop for Output {
        fn drop(&mut self) {
            let _ = objc::try_catch(|| {
                self.player.stop();
                self.engine.stop();
            });
        }
    }

    pub fn play(bytes: &'static [u8], control: &PlaybackControl) -> Result<(), String> {
        objc::try_catch(|| play_inner(bytes, control))
            .map_err(|error| format!("Start sound output exception: {error:?}"))?
    }

    fn play_inner(bytes: &'static [u8], control: &PlaybackControl) -> Result<(), String> {
        let source = Decoder::new(Cursor::new(bytes)).map_err(|error| error.to_string())?;
        let channels = usize::from(source.channels());
        let rate = source.sample_rate();
        let samples: Vec<i16> = source.collect();
        let frames = u32::try_from(samples.len() / channels).map_err(|error| error.to_string())?;
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
        let (sender, receiver) = mpsc::channel();
        let mut callback = blocks::EscBlock::new1(move |kind| {
            let _ = sender.send(kind);
        });
        output.player.schedule_played_back(
            &buffer,
            av::audio::PlayerNodeCompletionCbType::DataPlayedBack,
            &mut callback,
        );
        if !control.start_native(|| output.player.play()) {
            return Ok(());
        }

        loop {
            if control.cancelled() {
                return Ok(());
            }
            match receiver.recv_timeout(Duration::from_millis(10)) {
                Ok(av::audio::PlayerNodeCompletionCbType::DataPlayedBack) => break,
                Ok(_) => return Err("Unexpected start sound completion".into()),
                Err(mpsc::RecvTimeoutError::Timeout) => {}
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    return Err("Start sound completion disconnected".into());
                }
            }
        }
        // DataPlayedBack includes device latency; allow the speaker's acoustic tail to clear too.
        std::thread::sleep(ACOUSTIC_SETTLING_TIME);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pre_capture_sound_requires_a_visible_multi_second_countdown() {
        for countdown in [None, Some(0), Some(1), Some(2), Some(3), Some(5), Some(10)] {
            assert!(!should_play_countdown_sound(countdown, false));
        }
        for countdown in [None, Some(0), Some(1)] {
            assert!(!should_play_countdown_sound(countdown, true));
        }
        for countdown in [Some(2), Some(3), Some(5), Some(10)] {
            assert!(should_play_countdown_sound(countdown, true));
        }
    }

    #[tokio::test]
    async fn waits_for_playback_worker_before_returning() {
        let (entered_tx, entered_rx) = tokio::sync::oneshot::channel();
        let (finish_tx, finish_rx) = std::sync::mpsc::channel();
        let playback = tokio::spawn(play_with_worker(
            Arc::new(PlaybackControl::default()),
            Duration::from_secs(2),
            Duration::ZERO,
            move |_| {
                entered_tx.send(()).unwrap();
                finish_rx.recv().unwrap();
                Ok(())
            },
        ));
        entered_rx.await.unwrap();
        assert!(!playback.is_finished());
        finish_tx.send(()).unwrap();
        playback.await.unwrap();
    }

    #[tokio::test]
    async fn timeout_prevents_a_delayed_worker_from_playing() {
        let (control_tx, control_rx) = tokio::sync::oneshot::channel();
        let (finish_tx, finish_rx) = std::sync::mpsc::channel();
        play_with_worker(
            Arc::new(PlaybackControl::default()),
            Duration::from_millis(20),
            Duration::ZERO,
            move |control| {
                control_tx.send(control).ok().unwrap();
                finish_rx.recv().unwrap();
                Ok(())
            },
        )
        .await;
        let control = control_rx.await.unwrap();
        let (sink, _output) = Sink::new_idle();
        assert!(!control.start(
            Arc::new(sink),
            rodio::buffer::SamplesBuffer::new(1, 48000, vec![1i16; 10])
        ));
        finish_tx.send(()).unwrap();
    }

    #[tokio::test]
    async fn dropping_startup_cancels_playback() {
        let (control_tx, control_rx) = tokio::sync::oneshot::channel();
        let (finish_tx, finish_rx) = std::sync::mpsc::channel();
        let playback = tokio::spawn(play_with_worker(
            Arc::new(PlaybackControl::default()),
            Duration::from_secs(2),
            Duration::ZERO,
            move |control| {
                control_tx.send(control).ok().unwrap();
                finish_rx.recv().unwrap();
                Ok(())
            },
        ));
        let control = control_rx.await.unwrap();
        playback.abort();
        assert!(playback.await.unwrap_err().is_cancelled());
        assert!(control.cancelled());
        finish_tx.send(()).unwrap();
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn cancellation_prevents_late_native_playback() {
        let control = PlaybackControl::default();
        assert!(!control.cancel());
        assert!(!control.start_native(|| panic!("Cancelled output must not play")));
        assert!(!control.started());
    }

    #[cfg(target_os = "macos")]
    #[tokio::test]
    async fn native_playback_timeout_waits_for_buffered_audio_to_settle() {
        let control = Arc::new(PlaybackControl::default());
        assert!(control.start_native(|| {}));
        let (finish_tx, finish_rx) = std::sync::mpsc::channel();
        let timeout = Duration::from_millis(20);
        let settling_time = Duration::from_millis(30);
        let started = std::time::Instant::now();
        play_with_worker(control.clone(), timeout, settling_time, move |_| {
            finish_rx.recv().unwrap();
            Ok(())
        })
        .await;
        assert!(control.cancelled());
        assert!(started.elapsed() >= timeout + settling_time);
        finish_tx.send(()).unwrap();
    }

    #[tokio::test]
    async fn unavailable_output_does_not_fail_recording_startup() {
        play_with_worker(
            Arc::new(PlaybackControl::default()),
            Duration::from_secs(1),
            Duration::ZERO,
            |_| Err("No audio output device".into()),
        )
        .await;
    }

    #[tokio::test]
    async fn failed_playback_waits_for_buffered_audio_to_settle() {
        let started = std::time::Instant::now();
        let settling_time = Duration::from_millis(30);
        play_with_worker(
            Arc::new(PlaybackControl::default()),
            Duration::from_secs(1),
            settling_time,
            |control| {
                let (sink, _output) = Sink::new_idle();
                assert!(control.start(
                    Arc::new(sink),
                    rodio::buffer::SamplesBuffer::new(1, 48000, vec![1i16; 10]),
                ));
                Err("Output disconnected after playback began".into())
            },
        )
        .await;
        assert!(started.elapsed() >= settling_time);
    }
}
