//! Switching the microphone or camera while a recording runs.
//!
//! Studio records each input as its own track per segment, so a switch cuts
//! the segment: pause, hand the actor the new device's lock, resume. The
//! time in between is counted as paused, so the bar's timer matches what
//! was recorded. Instant has one continuous audio track: the new microphone
//! is opened on a feed of its own first, and only once it works is the live
//! source moved onto it, so a device that fails to open never touches the
//! recording. Instant's camera is the on-screen bubble, which the recording
//! does not hold, so switching it is just a new preview selection.

use std::{sync::Arc, time::Instant};

use cap_recording::feeds::{camera, microphone};
use gpui::{AsyncApp, Context, WeakEntity};

use super::{Phase, RecordingSession};
use crate::{
    feeds::{Feeds, InputReady, SelectedCamera},
    i18n::tr,
    recording::{self, RecordingMode},
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum InputKind {
    Microphone,
    Camera,
}

#[derive(Clone, Debug, PartialEq)]
pub enum InputRequest {
    Microphone(Option<String>),
    Camera(Option<SelectedCamera>),
}

impl InputRequest {
    pub fn kind(&self) -> InputKind {
        match self {
            Self::Microphone(_) => InputKind::Microphone,
            Self::Camera(_) => InputKind::Camera,
        }
    }

    fn device_label(&self) -> String {
        match self {
            Self::Microphone(Some(label)) => label.clone(),
            Self::Microphone(None) => tr::main::device::no_microphone().to_owned(),
            Self::Camera(Some(camera)) => camera.label.clone(),
            Self::Camera(None) => tr::main::device::no_camera().to_owned(),
        }
    }
}

/// One switch runs at a time. Requests made while it runs collapse into the
/// newest one per input, which runs next, so rapid clicking ends on the last
/// choice without queueing every intermediate device.
#[derive(Default)]
pub(crate) struct InputSwitchState {
    pending: Option<InputKind>,
    queued: Vec<InputRequest>,
    pub(super) error: Option<String>,
    timer_frozen_at: Option<Instant>,
}

impl InputSwitchState {
    fn submit(&mut self, request: InputRequest) -> Option<InputRequest> {
        if self.pending.is_some() {
            self.queued.retain(|queued| queued.kind() != request.kind());
            self.queued.push(request);
            return None;
        }
        self.pending = Some(request.kind());
        Some(request)
    }

    fn finish(&mut self) -> Option<InputRequest> {
        self.pending = None;
        let next = (!self.queued.is_empty()).then(|| self.queued.remove(0));
        if let Some(next) = &next {
            self.pending = Some(next.kind());
        }
        next
    }
}

/// What a Studio switch did, for the session to settle its state on.
struct StudioSwitchOutcome {
    error: Option<String>,
    /// `Some(true)` when the recording was left paused (a resume failed),
    /// `Some(false)` when it runs again, `None` when the actor never answered.
    paused: Option<bool>,
}

impl RecordingSession {
    pub fn input_switch_pending(&self) -> Option<InputKind> {
        self.input_switch.pending
    }

    pub fn input_switch_error(&self) -> Option<&str> {
        self.input_switch.error.as_deref()
    }

    pub fn dismiss_input_switch_error(&mut self, cx: &mut Context<Self>) {
        if self.input_switch.error.take().is_some() {
            cx.notify();
        }
    }

    /// Pause and switching share one guard: a Studio switch pauses and
    /// resumes the actor itself, so neither may start while the other runs.
    fn input_switch_live(&self) -> bool {
        matches!(self.phase, Phase::Recording { .. })
            && !self.pipeline_failed
            && !self.pause_pending()
            && !self.pause_uncertain()
    }

    /// The recording started with a microphone and its pipeline can move to
    /// another one. One that started without a microphone has no audio track
    /// to put one on.
    pub fn microphone_switch_available(&self) -> bool {
        self.input_switch_live()
            && self.active.as_ref().is_some_and(|active| {
                active.mic_mute.is_some()
                    && match self.mode() {
                        Some(RecordingMode::Studio) => true,
                        Some(RecordingMode::Instant) => active.microphone_switch().is_some(),
                        None => false,
                    }
            })
    }

    /// The recording started with a camera that is not its only picture.
    /// Linux composites the camera into Instant recordings, which holds it.
    pub fn camera_switch_available(&self) -> bool {
        self.input_switch_live()
            && self.active.as_ref().is_some_and(|active| {
                active.started_with_camera()
                    && !active.camera_only()
                    && match self.mode() {
                        Some(RecordingMode::Studio) => true,
                        Some(RecordingMode::Instant) => cfg!(not(target_os = "linux")),
                        None => false,
                    }
            })
    }

    pub fn switch_input(&mut self, request: InputRequest, cx: &mut Context<Self>) {
        let available = match request.kind() {
            InputKind::Microphone => self.microphone_switch_available(),
            InputKind::Camera => self.camera_switch_available(),
        };
        if !available {
            return;
        }
        if let Some(request) = self.input_switch.submit(request) {
            self.run_input_switch(request, cx);
        }
        cx.notify();
    }

    fn finish_input_switch(&mut self, generation: u64, cx: &mut Context<Self>) {
        if generation != self.recording_generation {
            return;
        }
        if let Some(frozen_at) = self.input_switch.timer_frozen_at.take()
            && self.paused_since == Some(frozen_at)
            && self.phase == (Phase::Recording { paused: false })
        {
            self.paused_since = None;
            self.paused_accum += frozen_at.elapsed();
        }
        while let Some(next) = self.input_switch.finish() {
            let available = match next.kind() {
                InputKind::Microphone => self.microphone_switch_available(),
                InputKind::Camera => self.camera_switch_available(),
            };
            if available {
                self.run_input_switch(next, cx);
                break;
            }
        }
        cx.notify();
    }

    fn run_input_switch(&mut self, request: InputRequest, cx: &mut Context<Self>) {
        let generation = self.recording_generation;
        match self.mode() {
            Some(RecordingMode::Instant) => self.run_instant_switch(request, generation, cx),
            Some(RecordingMode::Studio) => self.run_studio_switch(request, generation, cx),
            None => self.finish_input_switch(generation, cx),
        }
    }

    fn run_instant_switch(
        &mut self,
        request: InputRequest,
        generation: u64,
        cx: &mut Context<Self>,
    ) {
        match request {
            InputRequest::Camera(selection) => {
                Feeds::global(cx).update(cx, |feeds, cx| {
                    let selected = selection.is_some();
                    feeds.set_camera(selection, cx);
                    if selected {
                        feeds.resume_camera_preview(cx);
                    }
                });
                self.input_switch.error = None;
                self.finish_input_switch(generation, cx);
            }
            InputRequest::Microphone(None) => {
                self.set_instant_microphone_muted(true);
                self.input_switch.error = None;
                self.finish_input_switch(generation, cx);
            }
            InputRequest::Microphone(Some(label)) => {
                let current = Feeds::global(cx).read(cx).microphone.clone();
                if current.as_deref() == Some(label.as_str()) {
                    self.set_instant_microphone_muted(false);
                    self.input_switch.error = None;
                    self.finish_input_switch(generation, cx);
                    return;
                }
                let Some(switch) = self
                    .active
                    .as_ref()
                    .and_then(|active| active.microphone_switch())
                else {
                    self.finish_input_switch(generation, cx);
                    return;
                };
                let settings = crate::store::RecordingDeviceSettings::for_microphone(&label);
                let meter = Feeds::global(cx).read(cx).mic_meter();
                let opening = label.clone();
                let task = gpui_tokio::Tokio::spawn_result(cx, async move {
                    let opened = recording::open_microphone(&opening, settings, meter).await?;
                    switch.switch(opened.lock.clone()).await?;
                    Ok(opened)
                });
                cx.spawn(async move |this, cx| {
                    let result = task.await;
                    this.update(cx, |this, cx| {
                        if generation != this.recording_generation {
                            return;
                        }
                        match result {
                            Ok(opened) => {
                                if let Some(active) = &this.active {
                                    active.adopt_switched_microphone(opened);
                                }
                                Feeds::global(cx).update(cx, |feeds, cx| {
                                    feeds.adopt_recording_microphone(label.clone(), cx);
                                });
                                this.set_instant_microphone_muted(false);
                                this.input_switch.error = None;
                                tracing::info!(microphone = %label, "instant recording switched microphone");
                            }
                            Err(error) => {
                                tracing::warn!(microphone = %label, "instant microphone switch failed: {error:#}");
                                this.input_switch.error =
                                    Some(tr::controls::settings::switch_failed(&label));
                            }
                        }
                        this.finish_input_switch(generation, cx);
                    })
                    .ok();
                })
                .detach();
            }
        }
    }

    /// Instant's "No microphone" keeps the track and its timeline and sends
    /// silence, the same seam the bar's mute uses.
    fn set_instant_microphone_muted(&mut self, muted: bool) {
        let Some(mute) = self
            .active
            .as_ref()
            .and_then(|active| active.mic_mute.clone())
        else {
            return;
        };
        self.mic_muted = muted;
        mute.store(muted, std::sync::atomic::Ordering::Relaxed);
    }

    fn run_studio_switch(
        &mut self,
        request: InputRequest,
        generation: u64,
        cx: &mut Context<Self>,
    ) {
        let Some(handle) = self
            .active
            .as_ref()
            .and_then(|active| active.studio_handle())
        else {
            self.finish_input_switch(generation, cx);
            return;
        };
        let previous = match &request {
            InputRequest::Microphone(_) => {
                InputRequest::Microphone(Feeds::global(cx).read(cx).microphone.clone())
            }
            InputRequest::Camera(_) => {
                InputRequest::Camera(Feeds::global(cx).read(cx).camera.clone())
            }
        };
        if previous == request {
            self.input_switch.error = None;
            self.finish_input_switch(generation, cx);
            return;
        }
        let was_paused = self.is_paused();
        if !was_paused && self.paused_since.is_none() {
            let now = Instant::now();
            self.paused_since = Some(now);
            self.input_switch.timer_frozen_at = Some(now);
        }
        cx.spawn(async move |this, cx| {
            let outcome =
                studio_switch(&this, cx, handle, request, previous, was_paused, generation).await;
            this.update(cx, |this, cx| {
                if generation != this.recording_generation {
                    return;
                }
                if let Some(paused) = outcome.paused
                    && paused
                    && !was_paused
                    && this.phase == (Phase::Recording { paused: false })
                {
                    this.phase = Phase::Recording { paused: true };
                    this.input_switch.timer_frozen_at = None;
                }
                this.input_switch.error = outcome.error;
                this.finish_input_switch(generation, cx);
            })
            .ok();
        })
        .detach();
    }

    fn still_switching(&self, generation: u64) -> bool {
        generation == self.recording_generation && matches!(self.phase, Phase::Recording { .. })
    }
}

async fn studio_switch(
    this: &WeakEntity<RecordingSession>,
    cx: &mut AsyncApp,
    handle: cap_recording::studio_recording::ActorHandle,
    request: InputRequest,
    previous: InputRequest,
    was_paused: bool,
    generation: u64,
) -> StudioSwitchOutcome {
    let current = |cx: &mut AsyncApp| {
        this.read_with(cx, |session, _| session.still_switching(generation))
            .unwrap_or(false)
    };

    if !was_paused {
        let pause = handle.clone();
        let paused = gpui_tokio::Tokio::spawn_result(cx, async move { pause.pause().await }).await;
        if let Err(error) = paused {
            tracing::warn!("pausing for an input switch failed: {error:#}");
            return StudioSwitchOutcome {
                error: Some(tr::controls::settings::switch_failed(
                    &request.device_label(),
                )),
                paused: Some(false),
            };
        }
    }

    let kind = request.kind();
    let detach = handle.clone();
    let detached = gpui_tokio::Tokio::spawn_result(cx, async move {
        match kind {
            InputKind::Microphone => detach.set_mic_feed(None).await,
            InputKind::Camera => detach.set_camera_feed(None).await,
        }
    })
    .await;

    let mut error = None;
    if let Err(detach_error) = detached {
        tracing::warn!("detaching the old input failed: {detach_error:#}");
        error = Some(tr::controls::settings::switch_failed(
            &request.device_label(),
        ));
    } else if current(cx) {
        match attach_selection(this, cx, &handle, &request).await {
            Ok(()) => {}
            Err(attach_error) => {
                tracing::warn!(
                    device = %request.device_label(),
                    "studio input switch failed, restoring the previous input: {attach_error:#}"
                );
                error = Some(tr::controls::settings::switch_failed(
                    &request.device_label(),
                ));
                if current(cx)
                    && let Err(restore_error) = attach_selection(this, cx, &handle, &previous).await
                {
                    tracing::error!("restoring the previous input failed: {restore_error:#}");
                }
            }
        }
    }

    if was_paused || !current(cx) {
        return StudioSwitchOutcome {
            error,
            paused: Some(was_paused),
        };
    }
    let resume = handle.clone();
    match gpui_tokio::Tokio::spawn_result(cx, async move { resume.resume().await }).await {
        Ok(()) => StudioSwitchOutcome {
            error,
            paused: Some(false),
        },
        Err(resume_error) => {
            tracing::error!("resuming after an input switch failed: {resume_error:#}");
            let query = handle.clone();
            let paused =
                gpui_tokio::Tokio::spawn_result(cx, async move { query.is_paused().await })
                    .await
                    .ok();
            StudioSwitchOutcome {
                error: Some(format!(
                    "{resume_error:#}. Use Stop if recording cannot continue safely."
                )),
                paused,
            }
        }
    }
}

/// Points the app's feed at `request` and hands the paused Studio actor its
/// lock. `None` leaves the input off for the next segments.
async fn attach_selection(
    this: &WeakEntity<RecordingSession>,
    cx: &mut AsyncApp,
    handle: &cap_recording::studio_recording::ActorHandle,
    request: &InputRequest,
) -> anyhow::Result<()> {
    let selection = request.clone();
    let (ready, mic, camera): (
        Option<InputReady>,
        Option<kameo::actor::ActorRef<microphone::MicrophoneFeed>>,
        Option<kameo::actor::ActorRef<camera::CameraFeed>>,
    ) = this.update(cx, |_, cx| {
        Feeds::global(cx).update(cx, |feeds, cx| match selection {
            InputRequest::Microphone(label) => {
                feeds.set_microphone(label, cx);
                (feeds.input_readiness().microphone, feeds.mic_actor(), None)
            }
            InputRequest::Camera(camera) => {
                let selected = camera.is_some();
                feeds.set_camera(camera, cx);
                if selected {
                    feeds.resume_camera_preview(cx);
                }
                (feeds.input_readiness().camera, None, feeds.camera_actor())
            }
        })
    })?;

    match request {
        InputRequest::Microphone(None) | InputRequest::Camera(None) => return Ok(()),
        InputRequest::Microphone(Some(label)) => {
            let ready = ready.ok_or_else(|| anyhow::anyhow!("Microphone is not opening"))?;
            let actor = mic.ok_or_else(|| anyhow::anyhow!("Microphone feed is not running"))?;
            let label = label.clone();
            let handle = handle.clone();
            gpui_tokio::Tokio::spawn_result(cx, async move {
                ready.await.map_err(anyhow::Error::msg)?;
                let lock = actor
                    .ask(microphone::Lock)
                    .await
                    .map_err(|error| anyhow::anyhow!("microphone lock: {error}"))?;
                anyhow::ensure!(
                    lock.device_name() == label,
                    "The microphone feed opened '{}' instead of '{label}'",
                    lock.device_name()
                );
                handle.set_mic_feed(Some(Arc::new(lock))).await
            })
            .await?;
        }
        InputRequest::Camera(Some(selected)) => {
            let ready = ready.ok_or_else(|| anyhow::anyhow!("Camera is not opening"))?;
            let actor = camera.ok_or_else(|| anyhow::anyhow!("Camera feed is not running"))?;
            let selected = selected.clone();
            let attach = handle.clone();
            gpui_tokio::Tokio::spawn_result(cx, async move {
                ready.await.map_err(anyhow::Error::msg)?;
                let lock = actor
                    .ask(camera::Lock)
                    .await
                    .map_err(|error| anyhow::anyhow!("camera lock: {error}"))?;
                let info = lock.camera_info();
                anyhow::ensure!(
                    info.device_id() == selected.device_id,
                    "The camera feed opened a different camera"
                );
                attach.set_camera_feed(Some(Arc::new(lock))).await
            })
            .await?;
            #[cfg(target_os = "macos")]
            {
                let bubble = cx.update(crate::app_windows::camera_window_id);
                if let Some(bubble) = bubble {
                    let exclude = handle.clone();
                    gpui_tokio::Tokio::spawn_result(cx, async move {
                        exclude.add_excluded_windows(vec![bubble]).await
                    })
                    .await?;
                }
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mic(label: &str) -> InputRequest {
        InputRequest::Microphone(Some(label.to_owned()))
    }

    #[test]
    fn rapid_switches_collapse_to_the_newest_choice() {
        let mut state = InputSwitchState::default();
        assert_eq!(state.submit(mic("a")), Some(mic("a")));
        assert_eq!(state.pending, Some(InputKind::Microphone));
        assert_eq!(state.submit(mic("b")), None);
        assert_eq!(state.submit(mic("c")), None);
        assert_eq!(state.submit(InputRequest::Microphone(None)), None);
        assert_eq!(state.finish(), Some(InputRequest::Microphone(None)));
        assert_eq!(state.pending, Some(InputKind::Microphone));
        assert_eq!(state.finish(), None);
        assert_eq!(state.pending, None);
    }

    #[test]
    fn a_camera_request_waits_for_a_running_microphone_switch_and_is_never_dropped() {
        let mut state = InputSwitchState::default();
        assert!(state.submit(mic("a")).is_some());
        assert_eq!(state.submit(InputRequest::Camera(None)), None);
        assert_eq!(state.submit(mic("b")), None);
        assert_eq!(state.finish(), Some(InputRequest::Camera(None)));
        assert_eq!(state.pending, Some(InputKind::Camera));
        assert_eq!(state.finish(), Some(mic("b")));
        assert_eq!(state.finish(), None);
    }
}
