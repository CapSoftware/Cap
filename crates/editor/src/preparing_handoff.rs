use crate::preparing_audio::PreparingAudioOutputHandle;
use crate::{CompletedAudioHandoff, PreparingPlaybackSnapshot, PreparingPlaybackStopHandle};
use std::sync::{Arc, Mutex, Weak};
use std::time::Instant;
use tokio::sync::watch;

pub(crate) fn presentation_frame(snapshot: &PreparingPlaybackSnapshot, fps: u32) -> u32 {
    let requested = (snapshot.playback.playhead_seconds * f64::from(fps)).floor() as u32;
    snapshot
        .progress
        .total_duration
        .map_or(requested, |duration| {
            requested.min(((duration * f64::from(fps)).ceil() as u32).saturating_sub(1))
        })
}

pub(crate) type CompletedTrackIdentity = Vec<[Option<Weak<cap_audio::DecodedAudio>>; 2]>;

pub(crate) fn completed_track_identity(
    tracks: &[crate::completed_audio::CompletedAudioSegment],
) -> CompletedTrackIdentity {
    tracks
        .iter()
        .map(|track| {
            [
                track.mic.as_ref().map(Arc::downgrade),
                track.system_audio.as_ref().map(Arc::downgrade),
            ]
        })
        .collect()
}

fn same_completed_tracks(left: &CompletedTrackIdentity, right: &CompletedTrackIdentity) -> bool {
    left.len() == right.len()
        && left.iter().zip(right).all(|(left, right)| {
            left.iter()
                .zip(right)
                .all(|(left, right)| match (left, right) {
                    (None, None) => true,
                    (Some(left), Some(right)) => Weak::ptr_eq(left, right),
                    _ => false,
                })
        })
}

#[derive(Default)]
struct HandoffDecision {
    revision: u64,
    owner: u64,
    pending_commands: usize,
    stopped: bool,
}

pub(crate) struct HandoffState {
    snapshot: Mutex<Option<(PreparingPlaybackSnapshot, Instant, f64)>>,
    audio: Mutex<Option<PreparingAudioOutputHandle>>,
    identity: Mutex<Option<(CompletedTrackIdentity, Weak<crate::AudioOutput>)>>,
    pub(crate) completed_audio: Arc<Mutex<Option<CompletedAudioHandoff>>>,
    ready: watch::Sender<Result<bool, String>>,
    changed: watch::Sender<u64>,
    decision: Mutex<HandoffDecision>,
}

impl HandoffState {
    pub(crate) fn new() -> Arc<Self> {
        Arc::new(Self {
            snapshot: Mutex::new(None),
            audio: Mutex::new(None),
            identity: Mutex::new(None),
            completed_audio: Arc::default(),
            ready: watch::channel(Ok(false)).0,
            changed: watch::channel(0).0,
            decision: Mutex::default(),
        })
    }

    pub(crate) fn publish(&self, snapshot: PreparingPlaybackSnapshot, position: f64) {
        let _decision = self
            .decision
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        *self
            .snapshot
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) =
            Some((snapshot, Instant::now(), position));
    }

    pub(crate) fn set_audio(&self, audio: Option<PreparingAudioOutputHandle>) {
        *self
            .audio
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = audio;
    }

    pub(crate) fn ready(&self) -> bool {
        matches!(*self.ready.borrow(), Ok(true))
    }

    pub(crate) fn set_completed_identity(
        &self,
        tracks: &[crate::completed_audio::CompletedAudioSegment],
        output: &Arc<crate::AudioOutput>,
    ) {
        *self
            .identity
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) =
            Some((completed_track_identity(tracks), Arc::downgrade(output)));
    }

    pub(crate) fn complete(&self, audio: CompletedAudioHandoff) {
        let decision = self
            .decision
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if !self.ready() && !decision.stopped {
            *self
                .completed_audio
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(audio);
            let _ = self.ready.send_replace(Ok(true));
        }
    }

    pub(crate) fn cancel_adoption(&self) {
        self.decision
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .stopped = true;
        self.changed
            .send_modify(|revision| *revision = revision.wrapping_add(1));
    }

    pub(crate) fn finish(&self, error: Option<String>) {
        self.decision
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .stopped = true;
        if let Some(error) = error {
            let _ = self.ready.send_replace(Err(error));
        } else if !self.ready() {
            let _ = self
                .ready
                .send_replace(Err("Preparing playback ended before audio completed".into()));
        }
        self.changed
            .send_modify(|revision| *revision = revision.wrapping_add(1));
    }

    pub(crate) fn begin_command(self: &Arc<Self>) -> Result<PreparingPlaybackIntent, String> {
        let mut decision = self
            .decision
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if decision.owner != 0 {
            return Err("Preparing playback has been adopted".into());
        }
        if decision.stopped {
            return Err("Preparing playback has ended".into());
        }
        decision.revision = decision.revision.wrapping_add(1).max(1);
        decision.pending_commands += 1;
        Ok(PreparingPlaybackIntent(self.clone()))
    }

    pub(crate) fn committed(&self) -> bool {
        self.decision
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .owner
            != 0
    }

    fn snapshot(&self, now: Instant) -> Option<PreparingPlaybackSnapshot> {
        let (mut snapshot, sampled, position) = self
            .snapshot
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()?;
        if let Some(audio) = self
            .audio
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .as_ref()
        {
            let status = audio.status(now);
            snapshot.playback.playhead_seconds = status.playhead_seconds;
            snapshot.playback.buffering = status.buffering;
            if status.ended || status.error.is_some() {
                snapshot.playback.playing = false;
            }
            if status.error.is_some() {
                snapshot.progress.phase = crate::PreparingEditorPhase::Unavailable;
            }
        } else if snapshot.playback.playing && !snapshot.playback.buffering {
            snapshot.playback.playhead_seconds = (position
                + now.saturating_duration_since(sampled).as_secs_f64())
            .min(snapshot.progress.playable_until);
        }
        Some(snapshot)
    }
}

pub struct PreparingPlaybackIntent(Arc<HandoffState>);

impl Drop for PreparingPlaybackIntent {
    fn drop(&mut self) {
        let mut decision = self
            .0
            .decision
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        decision.pending_commands = decision.pending_commands.saturating_sub(1);
        self.0
            .changed
            .send_modify(|revision| *revision = revision.wrapping_add(1));
    }
}

struct HandoffOwner {
    state: Arc<HandoffState>,
    stop: PreparingPlaybackStopHandle,
}

impl Drop for HandoffOwner {
    fn drop(&mut self) {
        self.stop.cancel();
    }
}

#[derive(Clone)]
pub struct PreparingPlaybackHandoff(Arc<HandoffOwner>);

impl PreparingPlaybackHandoff {
    pub(crate) fn new(state: Arc<HandoffState>, stop: PreparingPlaybackStopHandle) -> Self {
        let stop = stop.with_handoff(&state);
        Self(Arc::new(HandoffOwner { state, stop }))
    }

    pub async fn take_completed_audio(&self) -> Result<CompletedAudioHandoff, String> {
        let mut ready = self.0.state.ready.subscribe();
        let mut changed = self.0.state.changed.subscribe();
        loop {
            let status = ready.borrow_and_update().clone()?;
            if self
                .0
                .state
                .decision
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .stopped
            {
                return Err("Preparing playback has ended".into());
            }
            if status {
                return self
                    .0
                    .state
                    .completed_audio
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .take()
                    .ok_or_else(|| "Preparing audio was already transferred".into());
            }
            tokio::select! {
                result = ready.changed() => result.map_err(|_| "Preparing audio owner ended".to_string())?,
                result = changed.changed() => result.map_err(|_| "Preparing audio owner ended".to_string())?,
            }
        }
    }

    pub fn reserve_command(&self) -> Result<PreparingPlaybackIntent, String> {
        self.0.state.begin_command()
    }

    pub fn snapshot(&self) -> Option<PreparingPlaybackSnapshot> {
        self.0.state.snapshot(Instant::now())
    }

    pub fn prepare_adoption(&self) -> Result<PreparingPlaybackAdoption, String> {
        let mut decision = self
            .0
            .state
            .decision
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if !self.0.state.ready()
            || decision.stopped
            || decision.owner != 0
            || decision.pending_commands != 0
        {
            return Err("Preparing playback cannot be adopted".into());
        }
        decision.revision = decision.revision.wrapping_add(1).max(1);
        let revision = decision.revision;
        Ok(PreparingPlaybackAdoption {
            handoff: self.clone(),
            revision,
        })
    }

    pub(crate) fn matches_completed_audio(
        &self,
        identity: &CompletedTrackIdentity,
        output: &Arc<crate::AudioOutput>,
    ) -> bool {
        self.0
            .state
            .identity
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .as_ref()
            .is_some_and(|(expected, expected_output)| {
                same_completed_tracks(identity, expected)
                    && Weak::ptr_eq(expected_output, &Arc::downgrade(output))
            })
    }

    pub(crate) async fn prepare_when_settled(&self) -> Result<PreparingPlaybackAdoption, String> {
        let mut changed = self.0.state.changed.subscribe();
        loop {
            {
                let decision = self
                    .0
                    .state
                    .decision
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                if decision.stopped || decision.owner != 0 {
                    return Err("Preparing playback cannot retry adoption".into());
                }
                if decision.pending_commands == 0 {
                    break;
                }
            }
            changed
                .changed()
                .await
                .map_err(|_| "Preparing playback ended".to_string())?;
        }
        self.prepare_adoption()
    }

    pub fn committed(&self) -> bool {
        self.0.state.committed()
    }

    pub async fn wait_committed(&self) -> bool {
        let mut changed = self.0.state.changed.subscribe();
        while !self.committed()
            && !self
                .0
                .state
                .decision
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .stopped
        {
            if changed.changed().await.is_err() {
                break;
            }
        }
        self.committed()
    }

    pub fn cancel(&self) {
        self.0.stop.cancel();
    }

    pub async fn stop_and_wait(&self) -> crate::PreparingPlaybackExit {
        self.0.stop.stop_and_wait().await
    }
}

#[derive(Clone)]
pub struct PreparingPlaybackAdoption {
    handoff: PreparingPlaybackHandoff,
    revision: u64,
}

impl PreparingPlaybackAdoption {
    pub async fn retry(&self) -> Result<Self, String> {
        self.handoff.prepare_when_settled().await
    }

    pub fn snapshot(&self) -> Option<PreparingPlaybackSnapshot> {
        let decision = self
            .handoff
            .0
            .state
            .decision
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if decision.stopped || decision.revision != self.revision {
            return None;
        }
        self.handoff.snapshot()
    }

    pub fn frame_number(&self, fps: u32) -> Option<u32> {
        self.snapshot()
            .map(|snapshot| presentation_frame(&snapshot, fps))
    }

    pub fn invalidated(&self) -> bool {
        let decision = self
            .handoff
            .0
            .state
            .decision
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        decision.stopped || decision.revision != self.revision
    }

    pub fn try_commit(&self, frame: u32, fps: u32) -> bool {
        let mut decision = self
            .handoff
            .0
            .state
            .decision
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if fps == 0
            || decision.stopped
            || decision.revision != self.revision
            || decision.pending_commands != 0
        {
            return false;
        }
        let Some(snapshot) = self.handoff.snapshot() else {
            return false;
        };
        if snapshot.progress.phase == crate::PreparingEditorPhase::Unavailable {
            return false;
        }
        let current = presentation_frame(&snapshot, fps);
        if frame < current.saturating_sub(2) || frame > current.saturating_add(1) {
            return false;
        }
        if decision.owner != 0 {
            return decision.owner == self.revision;
        }
        decision.owner = self.revision;
        self.handoff.0.state.changed.send_replace(self.revision);
        true
    }

    pub fn is_owner(&self) -> bool {
        self.handoff
            .0
            .state
            .decision
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .owner
            == self.revision
    }

    pub fn cancel(&self) {
        if self.is_owner() {
            self.handoff.cancel();
        }
    }

    pub async fn stop_and_wait(&self) -> Option<crate::PreparingPlaybackExit> {
        if self.is_owner() {
            Some(self.handoff.stop_and_wait().await)
        } else {
            None
        }
    }
}

#[cfg(test)]
#[path = "preparing_handoff_tests.rs"]
mod tests;
