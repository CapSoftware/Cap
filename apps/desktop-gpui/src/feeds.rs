//! App-scoped device feeds -- the gpui counterpart of the Tauri `App` state's
//! `camera_feed` / `mic_feed`.
//!
//! Selecting a camera spins the feed up and opens the preview window
//! immediately, before any recording exists; selecting a microphone keeps a
//! meter running so the pickers and the recording bar can show a live level.
//! A recording then locks the *already running* feeds (`feeds::camera::Lock` /
//! `feeds::microphone::Lock`), exactly like `src-tauri/src/recording.rs`.
//!
//! Threading: kameo actors live on the tokio runtime, so every actor message
//! goes through `gpui_tokio::Tokio::spawn`. Frame and sample pumps await their
//! flume channels on the foreground executor -- each frame has to land on the
//! main thread anyway to repaint, so draining there avoids a second hop.

use std::time::{Duration, Instant};

use cap_recording::feeds::{
    camera::{self, CameraFeed},
    microphone::{self, MicrophoneFeed, MicrophoneSamples},
};
use gpui::{App, AppContext as _, Context, Entity, Global};
use kameo::{Actor as _, actor::ActorRef};

pub use cap_recording::feeds::camera::DeviceOrModelID;

use crate::app_windows;

/// How the pickers map dB to a 0..1 bar: `DeviceListPanel` in `index.tsx`
/// (`DB_SCALE = 40`, inverted, square-rooted). 1 = silence, 0 = full scale --
/// the overlay's `right` offset, kept in the same orientation as the web app.
pub fn picker_level(db: f64) -> f64 {
    (1.0 - ((db + 40.0).max(0.0) / 40.0)).max(0.0).sqrt()
}

/// How the recording bar maps dB to its little track: `createAudioInputLevel`
/// in `in-progress-recording.tsx` (-60..0 dB, linear, 0 = silence).
pub fn bar_level(db: f64) -> f64 {
    ((db + 60.0) / 60.0).clamp(0.0, 1.0)
}

pub struct Feeds {
    camera_actor: Option<ActorRef<CameraFeed>>,
    mic_actor: Option<ActorRef<MicrophoneFeed>>,
    /// Selected camera; `Some` while the preview window should exist.
    pub camera: Option<SelectedCamera>,
    /// Selected microphone name.
    pub microphone: Option<String>,
    /// Rolling 200ms max of the mic level, in dB FS. `-96` when silent/absent.
    pub mic_level_db: f64,
    pub camera_error: Option<String>,
    /// Bumped on every camera/mic selection change; async completions from a
    /// previous selection see a stale epoch and drop their result.
    camera_epoch: u64,
    mic_epoch: u64,
    // Channel-holding tasks; dropping them ends the pumps.
    _frame_pump: Option<gpui::Task<()>>,
    _meter_pump: Option<gpui::Task<()>>,
    // The mic error channel must outlive the stream (see recording.rs).
    _mic_errors: Option<flume::Receiver<cpal::StreamError>>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct SelectedCamera {
    pub id: DeviceOrModelID,
    pub label: String,
}

struct FeedsGlobal(Entity<Feeds>);
impl Global for FeedsGlobal {}

impl Feeds {
    pub fn init(cx: &mut App) -> Entity<Self> {
        let feeds = cx.new(|_| Self {
            camera_actor: None,
            mic_actor: None,
            camera: None,
            microphone: None,
            mic_level_db: -96.0,
            camera_error: None,
            camera_epoch: 0,
            mic_epoch: 0,
            _frame_pump: None,
            _meter_pump: None,
            _mic_errors: None,
        });
        cx.set_global(FeedsGlobal(feeds.clone()));
        feeds
    }

    pub fn global(cx: &App) -> Entity<Self> {
        cx.global::<FeedsGlobal>().0.clone()
    }

    /// The live actors, for a recording to lock. `None` when nothing is
    /// selected (or the actor died -- `recording::start` falls back to a
    /// per-recording feed in that case).
    pub fn camera_actor(&self) -> Option<ActorRef<CameraFeed>> {
        self.camera.as_ref()?;
        self.camera_actor.clone().filter(|actor| actor.is_alive())
    }

    pub fn mic_actor(&self) -> Option<ActorRef<MicrophoneFeed>> {
        self.microphone.as_ref()?;
        self.mic_actor.clone().filter(|actor| actor.is_alive())
    }

    /// Select (or deselect) the camera. Opens/closes the preview window and
    /// points the app-scoped feed at the device.
    pub fn set_camera(&mut self, selection: Option<SelectedCamera>, cx: &mut Context<Self>) {
        if self.camera == selection {
            return;
        }
        self.camera_epoch += 1;
        let epoch = self.camera_epoch;
        self.camera = selection.clone();
        self.camera_error = None;
        cx.notify();

        match selection {
            Some(selection) => {
                let actor = self.ensure_camera_actor(cx);
                let set = gpui_tokio::Tokio::spawn(cx, async move {
                    let ready = actor
                        .ask(camera::SetInput {
                            id: selection.id,
                            settings: None,
                        })
                        .await
                        .map_err(|e| e.to_string())?;
                    ready.await.map_err(|e| e.to_string())
                });
                cx.spawn(async move |this, cx| {
                    let result = match set.await {
                        Ok(result) => result.map(|_| ()),
                        Err(join_error) => Err(join_error.to_string()),
                    };
                    this.update(cx, |this, cx| {
                        if this.camera_epoch != epoch {
                            return;
                        }
                        if let Err(error) = result {
                            tracing::error!("camera input failed: {error}");
                            this.camera_error = Some(error);
                        }
                        cx.notify();
                    })
                    .ok();
                })
                .detach();
                // Deferred: `open_window` paints the new window's first frame
                // synchronously, and that render reads this very entity --
                // opening inside the update is a double-lease panic.
                cx.defer(app_windows::open_camera_window);
            }
            None => {
                if let Some(actor) = self.camera_actor.clone() {
                    gpui_tokio::Tokio::spawn(cx, async move {
                        let _ = actor.ask(camera::RemoveInput).await;
                    })
                    .detach();
                }
                cx.defer(app_windows::close_camera_window);
            }
        }
    }

    /// Select (or deselect) the microphone. The feed keeps running between
    /// recordings so the pickers and bar have a live level.
    pub fn set_microphone(&mut self, label: Option<String>, cx: &mut Context<Self>) {
        if self.microphone == label {
            return;
        }
        self.mic_epoch += 1;
        self.microphone = label.clone();
        self.mic_level_db = -96.0;
        cx.notify();

        let actor = self.ensure_mic_actor(cx);
        match label {
            Some(label) => {
                gpui_tokio::Tokio::spawn(cx, async move {
                    match actor
                        .ask(microphone::SetInput {
                            label: label.clone(),
                            settings: None,
                        })
                        .await
                    {
                        Ok(ready) => {
                            if let Err(error) = ready.await {
                                tracing::warn!("microphone '{label}' failed to open: {error}");
                            }
                        }
                        Err(error) => {
                            tracing::warn!("microphone '{label}' set-input failed: {error}")
                        }
                    }
                })
                .detach();
            }
            None => {
                gpui_tokio::Tokio::spawn(cx, async move {
                    let _ = actor.ask(microphone::RemoveInput).await;
                })
                .detach();
            }
        }
    }

    /// Drop the live camera and microphone inputs without forgetting what was
    /// selected.
    ///
    /// `CapWindowId::Main`'s `CloseRequested` arm (`lib.rs:5666-5697`): when
    /// nothing is recording, hiding the main window pauses the camera preview
    /// and `ask`s both feeds for `RemoveInput`. It does *not* clear the
    /// frontend's `rawOptions` -- the pickers still show the device that was
    /// chosen -- so neither does this: only the hardware is released.
    pub fn release_inputs(&mut self, cx: &mut Context<Self>) {
        if let Some(actor) = self.camera_actor.clone() {
            gpui_tokio::Tokio::spawn(cx, async move {
                if let Err(error) = actor.ask(camera::RemoveInput).await {
                    tracing::warn!("releasing the camera feed: {error}");
                }
            })
            .detach();
        }
        if let Some(actor) = self.mic_actor.clone() {
            gpui_tokio::Tokio::spawn(cx, async move {
                if let Err(error) = actor.ask(microphone::RemoveInput).await {
                    tracing::warn!("releasing the microphone feed: {error}");
                }
            })
            .detach();
        }
        self.mic_level_db = -96.0;
        cx.notify();
    }

    fn ensure_camera_actor(&mut self, cx: &mut Context<Self>) -> ActorRef<CameraFeed> {
        if let Some(actor) = self.camera_actor.clone()
            && actor.is_alive()
        {
            return actor;
        }

        // kameo spawns onto the ambient tokio runtime; this method runs on
        // gpui's main thread, so enter the gpui_tokio runtime first or the
        // spawn panics (unwind across the objc frame aborts the process).
        let actor = {
            let _runtime = gpui_tokio::Tokio::handle(cx).enter();
            CameraFeed::spawn(CameraFeed::default())
        };

        // The preview channel: bounded(4) so a stalled UI drops frames instead
        // of ballooning; the pump drains on the main thread and hands each
        // frame straight to the camera window.
        let (frame_tx, frame_rx) = flume::bounded::<cap_recording::NativeCameraFrame>(4);
        {
            let actor = actor.clone();
            gpui_tokio::Tokio::spawn(cx, async move {
                if let Err(error) = actor.ask(camera::AddNativeSender(frame_tx)).await {
                    tracing::error!("attaching camera preview sender: {error}");
                }
            })
            .detach();
        }

        let pump = cx.spawn(async move |_this, cx| {
            while let Ok(frame) = frame_rx.recv_async().await {
                // When no window is open (yet), the frame is dropped and the
                // channel keeps draining.
                cx.update(|cx| app_windows::deliver_camera_frame(frame, cx));
            }
        });
        self._frame_pump = Some(pump);
        self.camera_actor = Some(actor.clone());
        actor
    }

    fn ensure_mic_actor(&mut self, cx: &mut Context<Self>) -> ActorRef<MicrophoneFeed> {
        if let Some(actor) = self.mic_actor.clone()
            && actor.is_alive()
        {
            return actor;
        }

        let (error_tx, error_rx) = flume::unbounded();
        self._mic_errors = Some(error_rx);
        // Same runtime-entry requirement as the camera actor above.
        let actor = {
            let _runtime = gpui_tokio::Tokio::handle(cx).enter();
            MicrophoneFeed::spawn(MicrophoneFeed::new(error_tx))
        };

        // Meter channel, attached once for the actor's lifetime -- the same
        // shape as the Tauri `mic_meter_sender`.
        let (meter_tx, meter_rx) = flume::bounded::<MicrophoneSamples>(16);
        {
            let actor = actor.clone();
            gpui_tokio::Tokio::spawn(cx, async move {
                if let Err(error) = actor.ask(microphone::AddSender(meter_tx)).await {
                    tracing::error!("attaching mic meter sender: {error}");
                }
            })
            .detach();
        }

        let pump = cx.spawn(async move |this, cx| {
            // Port of `audio_meter.rs`: a 200ms max-hold window, coalesced to
            // ~20 updates/s so the meter does not repaint the window per audio
            // callback.
            let mut window_entries: Vec<(Instant, f64)> = Vec::new();
            let mut last_push = Instant::now() - Duration::from_secs(1);
            while let Ok(samples) = meter_rx.recv_async().await {
                let now = Instant::now();
                let db = db_fs(&samples);
                window_entries.push((now, db));
                window_entries
                    .retain(|(at, _)| now.duration_since(*at) <= Duration::from_millis(200));
                if now.duration_since(last_push) < Duration::from_millis(50) {
                    continue;
                }
                last_push = now;
                let max = window_entries
                    .iter()
                    .map(|(_, db)| *db)
                    .fold(f64::MIN, f64::max);
                if this
                    .update(cx, |this: &mut Feeds, cx| {
                        this.mic_level_db = max;
                        cx.notify();
                    })
                    .is_err()
                {
                    return;
                }
                cx.update(app_windows::refresh_controls_window);
            }
        });
        self._meter_pump = Some(pump);
        self.mic_actor = Some(actor.clone());
        actor
    }
}

/// `db_fs` from `src-tauri/src/audio_meter.rs`: peak of the batch as dB FS,
/// clamped to [-96, 0].
fn db_fs(samples: &MicrophoneSamples) -> f64 {
    use cpal::SampleFormat;

    let sample_size = samples.format.sample_size();
    if sample_size == 0 || samples.data.len() < sample_size {
        return -96.0;
    }
    let peak = samples
        .data
        .chunks_exact(sample_size)
        .map(|data| {
            let value: f64 = match samples.format {
                SampleFormat::I8 => i8::from_ne_bytes([data[0]]) as f64 / i8::MAX as f64,
                SampleFormat::U8 => u8::from_ne_bytes([data[0]]) as f64 / u8::MAX as f64 - 0.5,
                SampleFormat::I16 => {
                    i16::from_ne_bytes([data[0], data[1]]) as f64 / i16::MAX as f64
                }
                SampleFormat::U16 => {
                    u16::from_ne_bytes([data[0], data[1]]) as f64 / u16::MAX as f64 - 0.5
                }
                SampleFormat::I32 => {
                    i32::from_ne_bytes([data[0], data[1], data[2], data[3]]) as f64
                        / i32::MAX as f64
                }
                SampleFormat::U32 => {
                    u32::from_ne_bytes([data[0], data[1], data[2], data[3]]) as f64
                        / u32::MAX as f64
                        - 0.5
                }
                SampleFormat::F32 => {
                    f32::from_ne_bytes([data[0], data[1], data[2], data[3]]) as f64
                }
                SampleFormat::F64 => f64::from_ne_bytes([
                    data[0], data[1], data[2], data[3], data[4], data[5], data[6], data[7],
                ]),
                _ => 0.0,
            };
            value.abs()
        })
        .fold(0.0f64, f64::max);

    (20.0 * peak.log10()).clamp(-96.0, 0.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Both level mappings keep the web app's orientation: `picker_level` is 1
    /// at silence (it is the overlay's *right* offset), `bar_level` is 0 at
    /// silence (it is the track's fill fraction).
    #[test]
    fn level_mappings_match_the_web_formulas() {
        assert_eq!(picker_level(-96.0), 1.0);
        assert_eq!(picker_level(0.0), 0.0);
        assert!((picker_level(-20.0) - 0.5f64.sqrt()).abs() < 1e-9);

        assert_eq!(bar_level(-96.0), 0.0);
        assert_eq!(bar_level(-60.0), 0.0);
        assert_eq!(bar_level(0.0), 1.0);
        assert!((bar_level(-30.0) - 0.5).abs() < 1e-9);
    }
}
