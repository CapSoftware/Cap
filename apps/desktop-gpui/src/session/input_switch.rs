//! Switching the microphone or camera while a recording runs.
//!
//! Studio records each input as its own track per segment. A camera switch
//! moves the running segment's camera track to the new camera, so the screen
//! and microphone record straight through it. Any other Studio switch cuts
//! the segment: pause, hand the actor the new device's lock, resume. The
//! time in between is counted as paused, so the bar's timer matches what
//! was recorded. Instant has one continuous audio track: the new microphone
//! is opened on a feed of its own first, and only once it works is the live
//! source moved onto it, so a device that fails to open never touches the
//! recording. Instant's camera is the on-screen bubble, which the recording
//! does not hold, so switching it is a new preview selection, kept only once
//! the new camera opens.

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
    /// Inputs a failed Studio switch left off the recording: the new device
    /// did not attach and neither did the previous one, though `Feeds` still
    /// names it.
    unattached: Vec<InputKind>,
}

impl InputSwitchState {
    /// Choosing the device `Feeds` already names changes nothing, unless a
    /// failed switch left that input off the recording.
    fn already_selected(&self, kind: InputKind) -> bool {
        !self.unattached.contains(&kind)
    }

    fn settle(&mut self, kind: InputKind, attached: bool) {
        self.unattached.retain(|unattached| *unattached != kind);
        if !attached {
            self.unattached.push(kind);
        }
    }

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
    /// The old feed was taken off the recording, so whatever it reads next
    /// came through the app's feed, even if the switch then failed.
    detached: bool,
    /// The requested device is the one the recording reads now.
    attached: bool,
    /// `Some(true)` when the recording holds the input `Feeds` names,
    /// `Some(false)` when it holds none, `None` when the old input was never
    /// detached.
    holds_selection: Option<bool>,
}

impl RecordingSession {
    pub fn input_switch_pending(&self) -> Option<InputKind> {
        self.input_switch.pending
    }

    pub fn input_switch_error(&self) -> Option<&str> {
        self.input_switch.error.as_deref()
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
                let previous = Feeds::global(cx).read(cx).camera.clone();
                let ready = Feeds::global(cx).update(cx, |feeds, cx| {
                    show_camera(feeds, selection.clone(), cx);
                    feeds.input_readiness().camera
                });
                let Some(ready) = ready.filter(|_| selection.is_some() && previous != selection)
                else {
                    self.remember_input(&InputRequest::Camera(selection));
                    self.input_switch.error = None;
                    self.finish_input_switch(generation, cx);
                    return;
                };
                // The bubble is what Instant records: keep the working camera
                // unless the new one actually opens.
                let opening = gpui_tokio::Tokio::spawn_result(cx, async move {
                    ready.await.map_err(anyhow::Error::msg)
                });
                cx.spawn(async move |this, cx| {
                    let result = opening.await;
                    this.update(cx, |this, cx| {
                        if generation != this.recording_generation {
                            return;
                        }
                        // Stop parks the bubble, which fails a pending open: the
                        // recording is over, so neither restore nor remember.
                        if !this.still_switching(generation) {
                            this.finish_input_switch(generation, cx);
                            return;
                        }
                        let request = InputRequest::Camera(selection.clone());
                        match result {
                            Ok(_) => {
                                this.remember_input(&request);
                                this.input_switch.error = None;
                            }
                            Err(error) => {
                                tracing::warn!("instant camera switch failed: {error:#}");
                                Feeds::global(cx).update(cx, |feeds, cx| {
                                    if feeds.camera == selection {
                                        show_camera(feeds, previous.clone(), cx);
                                    }
                                });
                                this.input_switch.error = Some(
                                    tr::controls::settings::switch_failed(&request.device_label()),
                                );
                            }
                        }
                        this.finish_input_switch(generation, cx);
                    })
                    .ok();
                })
                .detach();
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
                                if let Some(active) = this.active.as_mut() {
                                    active.adopt_switched_microphone(opened);
                                    active.release_owned_microphone();
                                }
                                Feeds::global(cx).update(cx, |feeds, cx| {
                                    feeds.adopt_recording_microphone(label.clone(), cx);
                                });
                                this.set_instant_microphone_muted(false);
                                this.remember_input(&InputRequest::Microphone(Some(
                                    label.clone(),
                                )));
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
        if previous == request && self.input_switch.already_selected(request.kind()) {
            self.input_switch.error = None;
            self.finish_input_switch(generation, cx);
            return;
        }
        let was_paused = self.is_paused();
        let in_place = !was_paused
            && switches_camera_in_place(&request, &previous)
            && self.input_switch.already_selected(InputKind::Camera)
            && camera_stays_off_screen(cx);
        if !in_place {
            self.freeze_timer_for_switch(was_paused);
        }
        let requested = request.clone();
        cx.spawn(async move |this, cx| {
            let swapped = if in_place {
                studio_camera_swap(&this, cx, &handle, &request, &previous, generation).await
            } else {
                None
            };
            let outcome = match swapped {
                Some(outcome) => outcome,
                None => {
                    if in_place {
                        this.update(cx, |this, _| this.freeze_timer_for_switch(was_paused))
                            .ok();
                    }
                    studio_switch(&this, cx, handle, request, previous, was_paused, generation)
                        .await
                }
            };
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
                if let Some(attached) = outcome.holds_selection {
                    this.input_switch.settle(requested.kind(), attached);
                }
                if outcome.attached {
                    this.remember_input(&requested);
                }
                if outcome.detached
                    && let Some(active) = this.active.as_mut()
                {
                    match requested.kind() {
                        InputKind::Microphone => active.release_owned_microphone(),
                        InputKind::Camera => active.release_owned_camera(),
                    }
                }
                this.input_switch.error = outcome.error;
                this.finish_input_switch(generation, cx);
            })
            .ok();
        })
        .detach();
    }

    /// A switch that pauses the recording stops the bar's timer for as long
    /// as it runs, so the timer matches what was recorded.
    fn freeze_timer_for_switch(&mut self, was_paused: bool) {
        if !was_paused && self.paused_since.is_none() {
            let now = Instant::now();
            self.paused_since = Some(now);
            self.input_switch.timer_frozen_at = Some(now);
        }
    }

    /// Restart reuses the config the recording started with, so a switched
    /// input must replace the one recorded there, or the restarted recording
    /// asks the feed for the device it no longer has.
    fn remember_input(&mut self, request: &InputRequest) {
        let Some(config) = self.last_config.as_mut() else {
            return;
        };
        match request {
            InputRequest::Microphone(label) => {
                config.device_settings.microphone = label
                    .as_deref()
                    .and_then(crate::store::RecordingDeviceSettings::for_microphone);
                config.microphone = label.clone();
            }
            InputRequest::Camera(camera) => {
                config.device_settings.camera = camera.as_ref().and_then(|camera| {
                    crate::store::RecordingDeviceSettings::for_camera(
                        &camera.device_id,
                        camera.model_id.as_ref(),
                    )
                });
                config.camera = camera.as_ref().map(|camera| camera.id.clone());
            }
        }
    }

    fn still_switching(&self, generation: u64) -> bool {
        switch_is_current(self.phase, self.recording_generation, generation)
    }
}

/// Stop keeps the recording generation, so only the phase tells a switch that
/// its recording ended while it ran.
fn switch_is_current(phase: Phase, current: u64, generation: u64) -> bool {
    generation == current && matches!(phase, Phase::Recording { .. })
}

/// A camera to camera switch keeps the segment recording. Turning the camera
/// on or off changes which tracks the segment has, so that cuts it.
fn switches_camera_in_place(request: &InputRequest, previous: &InputRequest) -> bool {
    matches!(
        (request, previous),
        (InputRequest::Camera(Some(_)), InputRequest::Camera(Some(_)))
    )
}

/// The bubble is left out of the screen capture a segment starts with, so a
/// segment that keeps recording through a switch must not get a new one.
fn camera_stays_off_screen(cx: &gpui::App) -> bool {
    cfg!(not(target_os = "macos")) || crate::app_windows::camera_window_open(cx)
}

/// Points the preview at `selection` and brings the bubble back for a camera.
fn show_camera(feeds: &mut Feeds, selection: Option<SelectedCamera>, cx: &mut Context<Feeds>) {
    let selected = selection.is_some();
    feeds.set_camera(selection, cx);
    if selected {
        feeds.resume_camera_preview(cx);
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
                detached: false,
                attached: false,
                holds_selection: None,
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
    let mut attached = false;
    let mut holds_selection = None;
    let detached = match detached {
        Ok(()) => true,
        Err(detach_error) => {
            tracing::warn!("detaching the old input failed: {detach_error:#}");
            error = Some(tr::controls::settings::switch_failed(
                &request.device_label(),
            ));
            false
        }
    };
    if detached && current(cx) {
        let attach = attach_or_restore(this, cx, &handle, &request, &previous, generation).await;
        attached = attach.attached;
        holds_selection = Some(attach.holds_selection);
        error = error.or(attach.error);
    }

    if was_paused || !current(cx) {
        return StudioSwitchOutcome {
            error,
            paused: Some(was_paused),
            detached,
            attached,
            holds_selection,
        };
    }
    let resume = handle.clone();
    match gpui_tokio::Tokio::spawn_result(cx, async move { resume.resume().await }).await {
        Ok(()) => StudioSwitchOutcome {
            error,
            paused: Some(false),
            detached,
            attached,
            holds_selection,
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
                detached,
                attached,
                holds_selection,
            }
        }
    }
}

/// Moves the running segment's camera track to the requested camera without
/// pausing, so the screen and microphone never stop. `None`, with nothing
/// changed, when the segment cannot switch in place.
async fn studio_camera_swap(
    this: &WeakEntity<RecordingSession>,
    cx: &mut AsyncApp,
    handle: &cap_recording::studio_recording::ActorHandle,
    request: &InputRequest,
    previous: &InputRequest,
    generation: u64,
) -> Option<StudioSwitchOutcome> {
    let release = handle.clone();
    if let Err(error) =
        gpui_tokio::Tokio::spawn_result(
            cx,
            async move { release.release_camera_for_switch().await },
        )
        .await
    {
        tracing::info!("switching the camera at a segment boundary: {error:#}");
        return None;
    }
    let mut outcome = StudioSwitchOutcome {
        error: None,
        paused: Some(false),
        detached: true,
        attached: false,
        holds_selection: None,
    };
    let current = this
        .read_with(cx, |session, _| session.still_switching(generation))
        .unwrap_or(false);
    if current {
        let attach = attach_or_restore(this, cx, handle, request, previous, generation).await;
        outcome.error = attach.error;
        outcome.attached = attach.attached;
        outcome.holds_selection = Some(attach.holds_selection);
    }
    Some(outcome)
}

struct AttachOutcome {
    error: Option<String>,
    attached: bool,
    holds_selection: bool,
}

async fn attach_or_restore(
    this: &WeakEntity<RecordingSession>,
    cx: &mut AsyncApp,
    handle: &cap_recording::studio_recording::ActorHandle,
    request: &InputRequest,
    previous: &InputRequest,
    generation: u64,
) -> AttachOutcome {
    let attach_error = match attach_selection(this, cx, handle, request).await {
        Ok(()) => {
            return AttachOutcome {
                error: None,
                attached: true,
                holds_selection: true,
            };
        }
        Err(error) => error,
    };
    tracing::warn!(
        device = %request.device_label(),
        "studio input switch failed, restoring the previous input: {attach_error:#}"
    );
    let mut outcome = AttachOutcome {
        error: Some(tr::controls::settings::switch_failed(
            &request.device_label(),
        )),
        attached: false,
        holds_selection: false,
    };
    let current = this
        .read_with(cx, |session, _| session.still_switching(generation))
        .unwrap_or(false);
    if current {
        match attach_selection(this, cx, handle, previous).await {
            Ok(()) => outcome.holds_selection = true,
            Err(restore_error) => {
                tracing::error!("restoring the previous input failed: {restore_error:#}");
            }
        }
    }
    outcome
}

/// Points the app's feed at `request` and hands the Studio actor its lock:
/// a paused actor records it from the next segment, a camera track released
/// for an in-place switch from now. `None` leaves the input off for the next
/// segments.
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

    /// A Studio switch whose new device and whose restore both failed leaves
    /// the input off the recording while `Feeds` still names the old device.
    /// Choosing that device again must retry the attach instead of being
    /// skipped as a no-op, until an attach works.
    #[test]
    fn an_input_left_off_the_recording_is_reattached_when_chosen_again() {
        let mut state = InputSwitchState::default();
        assert!(state.already_selected(InputKind::Microphone));
        state.settle(InputKind::Microphone, false);
        assert!(!state.already_selected(InputKind::Microphone));
        assert!(state.already_selected(InputKind::Camera));
        state.settle(InputKind::Microphone, false);
        assert!(!state.already_selected(InputKind::Microphone));
        state.settle(InputKind::Microphone, true);
        assert!(state.already_selected(InputKind::Microphone));
        assert!(state.unattached.is_empty());
    }

    /// A camera open that fails because Stop parked the bubble must neither
    /// restore the old camera nor remember the new one: Stop leaves the
    /// generation alone, so the phase is what ends the switch.
    #[test]
    fn a_switch_outlived_by_its_recording_is_not_current() {
        for paused in [false, true] {
            assert!(switch_is_current(Phase::Recording { paused }, 3, 3));
            assert!(!switch_is_current(Phase::Recording { paused }, 4, 3));
        }
        for phase in [Phase::Stopping, Phase::Idle, Phase::Starting] {
            assert!(!switch_is_current(phase, 3, 3));
        }
    }
}
