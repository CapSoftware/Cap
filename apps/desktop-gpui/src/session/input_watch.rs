//! Noticing a microphone or camera unplugged mid-recording.
//!
//! The Tauri app polled the device lists once a second while a recording was
//! live (`spawn_microphone_watcher` / `spawn_camera_watcher`); so does this.
//! A missing device raises the bar's warning and the bubble's overlay while
//! the recording carries on: the microphone source fills silence and the
//! camera track simply has no new frames. When the same device is listed
//! again it is reopened on the feed the recording reads from, and the warning
//! clears once it is running.

use std::time::Duration;

use cap_recording::feeds::microphone;
use gpui::{AppContext as _, Context, Task};

use super::{InputKind, Phase, RecordingSession};
use crate::feeds::Feeds;

const POLL: Duration = Duration::from_secs(1);

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct DisconnectedInputs {
    pub microphone: bool,
    pub camera: bool,
}

#[derive(Default)]
pub(crate) struct InputWatchState {
    pub(super) disconnected: DisconnectedInputs,
    reconnecting: DisconnectedInputs,
    task: Option<Task<()>>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
struct WatchedInputs {
    microphone: Option<String>,
    camera: Option<String>,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
struct Presence {
    microphone: Option<bool>,
    camera: Option<bool>,
}

/// What a poll means: which inputs are now gone, and which came back and
/// should be reopened. An input the recording no longer uses is never
/// reported missing.
fn presence_update(
    current: DisconnectedInputs,
    presence: Presence,
) -> (DisconnectedInputs, DisconnectedInputs) {
    let mut next = current;
    let mut reopen = DisconnectedInputs::default();
    match presence.microphone {
        Some(false) => next.microphone = true,
        Some(true) => reopen.microphone = current.microphone,
        None => next.microphone = false,
    }
    match presence.camera {
        Some(false) => next.camera = true,
        Some(true) => reopen.camera = current.camera,
        None => next.camera = false,
    }
    (next, reopen)
}

impl RecordingSession {
    /// What the bar and bubble warn about. Nothing outside a live recording,
    /// and not a microphone Instant has turned off ("No microphone" or
    /// mute): it is still watched, so it is reopened if it comes back.
    pub fn disconnected_inputs(&self) -> DisconnectedInputs {
        if !matches!(self.phase, Phase::Recording { .. }) {
            return DisconnectedInputs::default();
        }
        let mut disconnected = self.input_watch.disconnected;
        if self.mode() == Some(crate::recording::RecordingMode::Instant) && self.mic_muted {
            disconnected.microphone = false;
        }
        disconnected
    }

    pub(super) fn start_input_watch(&mut self, cx: &mut Context<Self>) {
        self.input_watch = InputWatchState::default();
        let generation = self.recording_generation;
        self.input_watch.task = Some(cx.spawn(async move |this, cx| {
            loop {
                cx.background_executor().timer(POLL).await;
                let Ok(Some(watched)) = this.update(cx, |this, cx| {
                    (this.recording_generation == generation
                        && matches!(this.phase, Phase::Recording { .. }))
                    .then(|| this.watched_inputs(cx))
                }) else {
                    return;
                };
                let polled = watched.clone();
                let presence = cx
                    .background_executor()
                    .spawn(async move { list_presence(&polled) })
                    .await;
                if this
                    .update(cx, |this, cx| {
                        let current = this.watched_inputs(cx);
                        let presence = presence_for_current(&watched, &current, presence);
                        this.apply_presence(generation, presence, cx)
                    })
                    .is_err()
                {
                    return;
                }
            }
        }));
    }

    fn watched_inputs(&self, cx: &gpui::App) -> WatchedInputs {
        let Some(active) = self.active.as_ref() else {
            return WatchedInputs::default();
        };
        let feeds = Feeds::global(cx).read(cx);
        let switching = self.input_switch_pending();
        WatchedInputs {
            microphone: feeds
                .microphone
                .clone()
                .filter(|_| active.mic_mute.is_some() && switching != Some(InputKind::Microphone)),
            camera: feeds
                .camera
                .as_ref()
                .map(|camera| camera.device_id.clone())
                .filter(|_| active.started_with_camera() && switching != Some(InputKind::Camera)),
        }
    }

    fn apply_presence(&mut self, generation: u64, presence: Presence, cx: &mut Context<Self>) {
        if generation != self.recording_generation || !matches!(self.phase, Phase::Recording { .. })
        {
            return;
        }
        let current = self.input_watch.disconnected;
        let (next, reopen) = presence_update(current, presence);
        if next != current {
            if next.microphone && !current.microphone {
                tracing::warn!(
                    "recording microphone disconnected; recording continues with silence"
                );
            }
            if next.camera && !current.camera {
                tracing::warn!("recording camera disconnected; recording continues without it");
            }
            self.input_watch.disconnected = next;
            cx.notify();
        }
        if reopen.microphone && !self.input_watch.reconnecting.microphone {
            self.reopen_microphone(generation, cx);
        }
        if reopen.camera && !self.input_watch.reconnecting.camera {
            self.reopen_camera(generation, cx);
        }
    }

    /// Reopens the unplugged microphone on the feed the recording reads
    /// from, which takes it back without a new lock.
    fn reopen_microphone(&mut self, generation: u64, cx: &mut Context<Self>) {
        let Some(label) = Feeds::global(cx).read(cx).microphone.clone() else {
            return;
        };
        let actor = self
            .active
            .as_ref()
            .and_then(|active| active.switched_microphone_actor())
            .or_else(|| Feeds::global(cx).read(cx).mic_actor());
        let Some(actor) = actor else {
            return;
        };
        self.input_watch.reconnecting.microphone = true;
        let settings = crate::store::RecordingDeviceSettings::for_microphone(&label);
        let task = gpui_tokio::Tokio::spawn_result(cx, async move {
            let ready = actor
                .ask(microphone::SetInput { label, settings })
                .await
                .map_err(|error| anyhow::anyhow!("{error}"))?;
            ready.await.map_err(|error| anyhow::anyhow!("{error}"))?;
            Ok(())
        });
        cx.spawn(async move |this, cx| {
            let result = task.await;
            this.update(cx, |this, cx| {
                if generation != this.recording_generation {
                    return;
                }
                this.input_watch.reconnecting.microphone = false;
                match result {
                    Ok(()) => {
                        tracing::info!("recording microphone reconnected");
                        this.input_watch.disconnected.microphone = false;
                        cx.notify();
                    }
                    Err(error) => {
                        tracing::warn!("reopening the recording microphone failed: {error:#}");
                    }
                }
            })
            .ok();
        })
        .detach();
    }

    fn reopen_camera(&mut self, generation: u64, cx: &mut Context<Self>) {
        let ready = Feeds::global(cx).update(cx, |feeds, cx| {
            feeds.restart_camera(cx);
            feeds.input_readiness().camera
        });
        let Some(ready) = ready else {
            return;
        };
        self.input_watch.reconnecting.camera = true;
        cx.spawn(async move |this, cx| {
            let result = ready.await;
            this.update(cx, |this, cx| {
                if generation != this.recording_generation {
                    return;
                }
                this.input_watch.reconnecting.camera = false;
                match result {
                    Ok(_) => {
                        tracing::info!("recording camera reconnected");
                        this.input_watch.disconnected.camera = false;
                        cx.notify();
                    }
                    Err(error) => tracing::warn!("reopening the recording camera failed: {error}"),
                }
            })
            .ok();
        })
        .detach();
    }
}

/// A poll describes the devices watched when it started. An input switched
/// or turned off while it ran reads as unused, which clears its warning; the
/// next poll checks the new device.
fn presence_for_current(
    polled: &WatchedInputs,
    current: &WatchedInputs,
    presence: Presence,
) -> Presence {
    Presence {
        microphone: presence
            .microphone
            .filter(|_| polled.microphone == current.microphone),
        camera: presence.camera.filter(|_| polled.camera == current.camera),
    }
}

fn list_presence(watched: &WatchedInputs) -> Presence {
    Presence {
        microphone: watched.microphone.as_ref().map(|label| {
            microphone::MicrophoneFeed::list_names()
                .iter()
                .any(|name| name == label)
        }),
        camera: watched.camera.as_ref().map(|device_id| {
            cap_camera::list_cameras().any(|camera| camera.device_id() == device_id)
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn presence(microphone: Option<bool>, camera: Option<bool>) -> Presence {
        Presence { microphone, camera }
    }

    #[test]
    fn a_missing_device_warns_and_its_return_asks_for_a_reopen() {
        let none = DisconnectedInputs::default();
        let (gone, reopen) = presence_update(none, presence(Some(false), Some(true)));
        assert_eq!(
            gone,
            DisconnectedInputs {
                microphone: true,
                camera: false
            }
        );
        assert_eq!(reopen, none);

        let (still_gone, reopen) = presence_update(gone, presence(Some(true), Some(true)));
        assert_eq!(
            still_gone, gone,
            "the warning stays until the reopen succeeds"
        );
        assert!(reopen.microphone && !reopen.camera);
    }

    #[test]
    fn a_poll_of_a_device_switched_away_from_is_discarded() {
        let polled = WatchedInputs {
            microphone: Some("USB Mic".into()),
            camera: Some("camera-a".into()),
        };
        let current = WatchedInputs {
            microphone: Some("USB Mic".into()),
            camera: Some("camera-b".into()),
        };
        assert_eq!(
            presence_for_current(&polled, &current, presence(Some(false), Some(false))),
            presence(Some(false), None)
        );
    }

    #[test]
    fn an_input_the_recording_stopped_using_never_warns() {
        let both = DisconnectedInputs {
            microphone: true,
            camera: true,
        };
        let (next, reopen) = presence_update(both, presence(None, None));
        assert_eq!(next, DisconnectedInputs::default());
        assert_eq!(reopen, DisconnectedInputs::default());
    }
}
