use std::{
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use cap_audio::{ManagedAudioInput, ManagedAudioStopHandle, ManagedProgressiveAudio};
use cap_project::{StudioRecordingMeta, XY};
use futures::{
    FutureExt,
    future::{BoxFuture, Shared},
};
use tokio::sync::{mpsc, oneshot, watch};
use tokio_util::sync::CancellationToken;

use crate::{PreparingEditorPhase, PreparingEditorProgress, PreparingPlaybackState};

pub struct PreparingAudioSegmentInput {
    pub mic: Option<ManagedAudioInput>,
    pub system_audio: Option<ManagedAudioInput>,
    pub timing_repair: crate::SegmentAudioTimingRepair,
}

#[derive(Clone, Copy)]
pub struct PreparingPlaybackOptions {
    pub preview: crate::PreparingPreviewOptions,
    pub fps: u32,
    pub resolution: XY<u32>,
}

#[derive(Clone)]
pub struct PreparingPlaybackExit {
    pub snapshot: PreparingPlaybackSnapshot,
    pub preview: Option<crate::PreparingPreviewExit>,
    completed_audio: Arc<Mutex<Option<crate::CompletedAudioHandoff>>>,
    pub error: Option<String>,
    pub cleanup_failed: bool,
}

impl PreparingPlaybackExit {
    pub fn take_completed_audio(&self) -> Option<crate::CompletedAudioHandoff> {
        self.completed_audio
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .take()
    }
}

type CommandResult = oneshot::Sender<Result<(), String>>;

enum PreparingPlaybackCommand {
    Seek(f64, CommandResult),
    Playing(bool, CommandResult),
}

#[derive(Clone)]
pub struct PreparingPlaybackController {
    commands: mpsc::Sender<PreparingPlaybackCommand>,
    handoff: Arc<crate::preparing_handoff::HandoffState>,
}

impl PreparingPlaybackController {
    pub async fn seek(&self, seconds: f64) -> Result<(), String> {
        let _intent = self.handoff.begin_command()?;
        let (reply, received) = oneshot::channel();
        self.commands
            .send(PreparingPlaybackCommand::Seek(seconds, reply))
            .await
            .map_err(|_| "Preparing playback has ended".to_string())?;
        received
            .await
            .map_err(|_| "Preparing seek has ended".to_string())?
    }

    pub async fn set_playing(&self, playing: bool) -> Result<(), String> {
        let _intent = self.handoff.begin_command()?;
        let (reply, received) = oneshot::channel();
        self.commands
            .send(PreparingPlaybackCommand::Playing(playing, reply))
            .await
            .map_err(|_| "Preparing playback has ended".to_string())?;
        received
            .await
            .map_err(|_| "Preparing playback has ended".to_string())?
    }
}

#[derive(Clone)]
pub struct PreparingPlaybackStopHandle {
    handoff: std::sync::Weak<crate::preparing_handoff::HandoffState>,
    cancelled: CancellationToken,
    completion: Shared<BoxFuture<'static, PreparingPlaybackExit>>,
}

impl PreparingPlaybackStopHandle {
    #[cfg(test)]
    pub(crate) fn test_pending(snapshot: PreparingPlaybackSnapshot) -> (Self, CancellationToken) {
        let cancelled = CancellationToken::new();
        let completion_cancel = cancelled.clone();
        let completion = async move {
            completion_cancel.cancelled().await;
            PreparingPlaybackExit {
                snapshot,
                preview: None,
                completed_audio: Arc::default(),
                error: None,
                cleanup_failed: false,
            }
        }
        .boxed()
        .shared();
        (
            Self {
                handoff: Default::default(),
                cancelled: cancelled.clone(),
                completion,
            },
            cancelled,
        )
    }

    pub(crate) fn with_handoff(
        mut self,
        state: &Arc<crate::preparing_handoff::HandoffState>,
    ) -> Self {
        self.handoff = Arc::downgrade(state);
        self
    }

    pub fn cancel(&self) {
        if let Some(handoff) = self.handoff.upgrade() {
            handoff.cancel_adoption();
        }
        self.cancelled.cancel();
    }

    pub async fn stop_and_wait(&self) -> PreparingPlaybackExit {
        self.cancel();
        self.completion.clone().await
    }
}

pub struct PreparingPlaybackSession {
    controller: PreparingPlaybackController,
    stop: PreparingPlaybackStopHandle,
    updates: watch::Receiver<PreparingPlaybackSnapshot>,
    handoff: crate::PreparingPlaybackHandoff,
}

impl PreparingPlaybackSession {
    pub fn spawn(
        input: crate::PreparingPreviewInput,
        audio: Vec<PreparingAudioSegmentInput>,
        options: PreparingPlaybackOptions,
        audio_output: Arc<crate::AudioOutput>,
        callback: crate::PreparingPreviewCallback,
    ) -> Result<Self, String> {
        let expected = input.recording_meta.clone();
        Self::spawn_with_expected_metadata(input, audio, options, audio_output, callback, expected)
    }

    pub fn spawn_with_expected_metadata(
        input: crate::PreparingPreviewInput,
        audio: Vec<PreparingAudioSegmentInput>,
        options: PreparingPlaybackOptions,
        audio_output: Arc<crate::AudioOutput>,
        callback: crate::PreparingPreviewCallback,
        expected_finalized_metadata: cap_project::RecordingMeta,
    ) -> Result<Self, String> {
        validate_expected_metadata(&input.recording_meta, &expected_finalized_metadata)?;
        crate::preparing_preview::validate_input(&input).map_err(|error| error.to_string())?;
        if options.fps == 0
            || options.fps > 240
            || options.resolution.x < 2
            || options.resolution.x > 8192
            || options.resolution.y < 2
            || options.resolution.y > 8192
        {
            return Err("Preparing playback output is invalid".into());
        }
        let Some(StudioRecordingMeta::MultipleSegments { inner }) =
            input.recording_meta.studio_meta()
        else {
            return Err("Preparing playback requires stopped segments".into());
        };
        if audio.len() != inner.segments.len() {
            return Err("Preparing audio layout does not match".into());
        }
        let required_audio: Vec<_> = inner
            .segments
            .iter()
            .map(|segment| [segment.mic.is_some(), segment.system_audio.is_some()])
            .collect();
        let durations: Vec<_> = input
            .project
            .timeline
            .as_ref()
            .ok_or("Preparing timeline is absent")?
            .segments
            .iter()
            .map(|segment| segment.end)
            .collect();
        let clock = PreparingPlaybackClock::new(
            &durations,
            &required_audio
                .iter()
                .map(|tracks| tracks.iter().any(|required| *required))
                .collect::<Vec<_>>(),
        )?;
        let runtime = tokio::runtime::Handle::try_current().map_err(|error| error.to_string())?;
        let (commands, received) = mpsc::channel(8);
        let (updates, receiver) = watch::channel(clock.snapshot.clone());
        let cancelled = CancellationToken::new();
        let handoff = crate::preparing_handoff::HandoffState::new();
        let runner = PreparingPlaybackRunner {
            handoff: handoff.clone(),
            source_metadata: input.recording_meta.clone(),
            clock,
            options,
            project: input.project.clone(),
            expected_finalized_metadata,
            audio_output,
            audio_ticket: None,
            audio_sources: None,
            audio: Vec::new(),
            audio_stops: Vec::new(),
            required_audio,
            completed_audio: Vec::new(),
            repairs: Vec::new(),
            preview: None,
            preview_cleanup_failed: false,
            pending: None,
            commands: received,
            updates,
            cancelled: cancelled.clone(),
            callback,
        };
        let fallback = runner.clock.snapshot.clone();
        let task = runtime.spawn(runner.run(input, audio));
        let completion = join_preparing_task(task, fallback, handoff.clone())
            .boxed()
            .shared();
        let retained = completion.clone();
        drop(runtime.spawn(async move {
            drop(retained.await);
        }));
        let stop = PreparingPlaybackStopHandle {
            handoff: Arc::downgrade(&handoff),
            cancelled,
            completion,
        };
        Ok(Self {
            controller: PreparingPlaybackController {
                commands,
                handoff: handoff.clone(),
            },
            handoff: crate::PreparingPlaybackHandoff::new(handoff, stop.clone()),
            stop,
            updates: receiver,
        })
    }

    pub fn handoff_handle(&self) -> crate::PreparingPlaybackHandoff {
        self.handoff.clone()
    }

    pub fn controller(&self) -> PreparingPlaybackController {
        self.controller.clone()
    }

    pub fn stop_handle(&self) -> PreparingPlaybackStopHandle {
        self.stop.clone()
    }

    pub fn updates(&self) -> watch::Receiver<PreparingPlaybackSnapshot> {
        self.updates.clone()
    }
}

fn validate_expected_metadata(
    source: &cap_project::RecordingMeta,
    expected: &cap_project::RecordingMeta,
) -> Result<(), String> {
    let mut cleared = source.clone();
    if let cap_project::RecordingMetaInner::Studio(studio) = &mut cleared.inner
        && let StudioRecordingMeta::MultipleSegments { inner } = studio.as_mut()
    {
        for segment in &mut inner.segments {
            for track in [&mut segment.mic, &mut segment.system_audio]
                .into_iter()
                .flatten()
            {
                track.gap_summary = None;
            }
        }
    }
    let serialize = |meta: &cap_project::RecordingMeta| {
        serde_json::to_value(meta).map_err(|error| error.to_string())
    };
    let expected_value = serialize(expected)?;
    if source.project_path != expected.project_path
        || (serialize(source)? != expected_value && serialize(&cleared)? != expected_value)
    {
        return Err("Preparing finalized metadata changes more than audio gap summaries".into());
    }
    Ok(())
}

enum FramePurpose {
    Display {
        reply: Option<CommandResult>,
        settle_playing: Option<bool>,
    },
    Probe(usize),
}

struct PendingFrame {
    sequence: u64,
    purpose: FramePurpose,
}

pub(crate) async fn join_preparing_task(
    task: tokio::task::JoinHandle<PreparingPlaybackExit>,
    fallback: PreparingPlaybackSnapshot,
    handoff: Arc<crate::preparing_handoff::HandoffState>,
) -> PreparingPlaybackExit {
    match task.await {
        Ok(exit) => exit,
        Err(error) => {
            let error = format!("Preparing playback cleanup failed: {error}");
            handoff.finish(Some(error.clone()));
            PreparingPlaybackExit {
                snapshot: fallback,
                preview: None,
                completed_audio: Arc::default(),
                error: Some(error),
                cleanup_failed: true,
            }
        }
    }
}

struct PreparingPlaybackRunner {
    handoff: Arc<crate::preparing_handoff::HandoffState>,
    source_metadata: cap_project::RecordingMeta,
    clock: PreparingPlaybackClock,
    options: PreparingPlaybackOptions,
    project: cap_project::ProjectConfiguration,
    expected_finalized_metadata: cap_project::RecordingMeta,
    audio_output: Arc<crate::AudioOutput>,
    audio_ticket: Option<crate::audio_output::PreparingAudioPlayTicket>,
    audio_sources: Option<crate::preparing_audio::PreparingAudioSources>,
    audio: Vec<[Option<ManagedProgressiveAudio>; 2]>,
    audio_stops: Vec<ManagedAudioStopHandle>,
    required_audio: Vec<[bool; 2]>,
    completed_audio: Vec<[Option<Arc<cap_audio::DecodedAudio>>; 2]>,
    repairs: Vec<crate::SegmentAudioTimingRepair>,
    preview: Option<crate::PreparingPreview>,
    preview_cleanup_failed: bool,
    pending: Option<PendingFrame>,
    commands: mpsc::Receiver<PreparingPlaybackCommand>,
    updates: watch::Sender<PreparingPlaybackSnapshot>,
    cancelled: CancellationToken,
    callback: crate::PreparingPreviewCallback,
}

impl PreparingPlaybackRunner {
    async fn run(
        mut self,
        input: crate::PreparingPreviewInput,
        audio: Vec<PreparingAudioSegmentInput>,
    ) -> PreparingPlaybackExit {
        let source_metadata = input.recording_meta.clone();
        let result = std::panic::AssertUnwindSafe(self.run_inner(input, audio))
            .catch_unwind()
            .await;
        let mut error = match result {
            Ok(Ok(())) => None,
            Ok(Err(error)) => Some(error),
            Err(_) => Some("Preparing playback task panicked".into()),
        };
        let audio_cleanup_failed = match self.stop_audio().await {
            Ok(()) => false,
            Err(cleanup_error) => {
                error = Some(cleanup_error);
                true
            }
        };
        self.clock.handoff();
        if error.is_some() {
            self.clock.snapshot.progress.phase = PreparingEditorPhase::Unavailable;
            self.clock.snapshot.progress.playable_until = 0.0;
            self.clock.snapshot.playback.playing = false;
        }
        let _ = self.publish();
        for stop in &self.audio_stops {
            stop.cancel();
        }
        let preview = if let Some(preview) = self.preview.take() {
            Some(preview.stop_handle().stop_and_wait().await)
        } else {
            None
        };
        let preview_cleanup_failed = preview
            .as_ref()
            .is_some_and(|exit| matches!(exit.reason, crate::PreparingPreviewError::TaskJoin(_)));
        let cleanup_failed =
            audio_cleanup_failed || preview_cleanup_failed || self.preview_cleanup_failed;
        if preview_cleanup_failed {
            error = Some("Preparing preview workers could not be joined".into());
        }
        for stop in &self.audio_stops {
            drop(stop.wait().await);
        }
        for (index, tracks) in self.audio.iter().enumerate() {
            for (track, audio) in tracks.iter().enumerate() {
                if let Some(audio) = audio
                    && audio.loader().progress().complete
                    && let Ok(Some(decoded)) = audio.loader().get().await
                {
                    self.completed_audio[index][track] = Some(decoded);
                }
            }
        }
        self.audio.clear();
        self.audio_sources = None;
        let completed_audio = crate::CompletedAudioHandoff::from_completed_tracks(
            &source_metadata,
            &self.expected_finalized_metadata,
            self.completed_audio
                .into_iter()
                .map(
                    |[mic, system_audio]| crate::completed_audio::CompletedAudioSegment {
                        mic,
                        system_audio,
                    },
                )
                .collect(),
        )
        .ok();
        if !self.handoff.ready() {
            *self
                .handoff
                .completed_audio
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner) = completed_audio;
        }
        self.handoff.finish(error.clone());
        PreparingPlaybackExit {
            snapshot: self.clock.snapshot,
            preview,
            completed_audio: self.handoff.completed_audio.clone(),
            error,
            cleanup_failed,
        }
    }

    fn publish(&mut self) -> Result<(), String> {
        let snapshot = self.clock.publish()?;
        self.handoff
            .publish(snapshot.clone(), self.clock.position_at(Instant::now()));
        self.handoff.set_audio(
            self.audio_ticket
                .as_ref()
                .and_then(|ticket| ticket.output_handle()),
        );
        self.updates.send_replace(snapshot);
        Ok(())
    }

    async fn stop_audio(&mut self) -> Result<(), String> {
        if let Some(ticket) = &self.audio_ticket {
            ticket.stop_and_wait().await?;
        }
        self.audio_ticket = None;
        Ok(())
    }

    async fn run_inner(
        &mut self,
        input: crate::PreparingPreviewInput,
        audio: Vec<PreparingAudioSegmentInput>,
    ) -> Result<(), String> {
        if self.cancelled.is_cancelled() {
            return Ok(());
        }
        for (index, audio) in audio.into_iter().enumerate() {
            let mut tracks = [None, None];
            for (track, input) in [audio.mic, audio.system_audio].into_iter().enumerate() {
                if let Some(input) = input {
                    if !self.required_audio[index][track] {
                        return Err("Unexpected preparing audio track".into());
                    }
                    let managed = ManagedProgressiveAudio::spawn(
                        input,
                        format!("Preparing {index} track {track}"),
                    )
                    .map_err(|error| error.to_string())?;
                    self.audio_stops.push(managed.stop_handle());
                    tracks[track] = Some(managed);
                }
            }
            self.audio.push(tracks);
            self.completed_audio.push([None, None]);
            self.repairs.push(audio.timing_repair);
        }
        let sources = crate::preparing_audio::PreparingAudioSources {
            project: Arc::new(self.project.clone()),
            tracks: self
                .audio
                .iter()
                .map(|tracks| {
                    tracks
                        .each_ref()
                        .map(|audio| audio.as_ref().map(|audio| audio.loader().clone()))
                })
                .collect(),
            required: self.required_audio.clone(),
            repairs: self.repairs.clone(),
        };
        sources.validate()?;
        self.audio_sources = Some(sources);
        if self
            .required_audio
            .iter()
            .flatten()
            .any(|required| *required)
        {
            self.audio_output.prewarm();
        }
        let (frames, received) = flume::bounded(1);
        let discard = received.clone();
        let preview = crate::PreparingPreview::spawn(
            input,
            self.options.preview,
            Box::new(move |request, output, layout| {
                deliver_latest(&frames, &discard, (request, output, layout));
            }),
        )
        .map_err(|error| error.to_string())?;
        self.preview = Some(preview);
        tokio::select! {
            biased;
            _ = self.cancelled.cancelled() => return Ok(()),
            ready = self.preview.as_mut().ok_or("Preparing preview is absent")?.wait_ready() => {
                ready.map_err(|error| error.to_string())?;
            }
        }
        self.request(
            0,
            FramePurpose::Display {
                reply: None,
                settle_playing: Some(false),
            },
        )?;
        let mut interval =
            tokio::time::interval(Duration::from_secs_f64(1.0 / f64::from(self.options.fps)));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        let mut commands_open = true;
        loop {
            tokio::select! {
                biased;
                _ = self.cancelled.cancelled() => return Ok(()),
                command = self.commands.recv(), if commands_open => {
                    let Some(command) = command else {
                        if !self.handoff.committed() { return Ok(()); }
                        commands_open = false;
                        continue;
                    };
                    self.command(command).await?;
                }
                frame = received.recv_async(), if self.preview.is_some() => {
                    let (request, output, layout) = frame.map_err(|error| error.to_string())?;
                    self.frame(request, output, layout).await?;
                }
                _ = interval.tick() => {
                    self.tick().await?;
                }
            }
        }
    }

    fn request(&mut self, frame: u32, purpose: FramePurpose) -> Result<(), String> {
        if let Some(PendingFrame {
            purpose: FramePurpose::Display {
                reply: Some(reply), ..
            },
            ..
        }) = self.pending.take()
        {
            let _ = reply.send(Err("Preparing seek was replaced".into()));
        }
        let sequence = self
            .preview
            .as_mut()
            .ok_or("Preparing preview is absent")?
            .request_frame(frame, self.options.fps, self.options.resolution)
            .map_err(|error| error.to_string())?;
        self.pending = Some(PendingFrame { sequence, purpose });
        Ok(())
    }

    async fn frame(
        &mut self,
        request: crate::PreparingFrameRequest,
        output: crate::EditorFrameOutput,
        layout: cap_rendering::FrameLayout,
    ) -> Result<(), String> {
        if self
            .pending
            .as_ref()
            .is_none_or(|pending| pending.sequence != request.sequence)
        {
            return Ok(());
        }
        let pending = self
            .pending
            .take()
            .ok_or("Preparing frame request is absent")?;
        let seconds = f64::from(request.frame_number) / f64::from(request.fps);
        let (_, segment) = self
            .project
            .get_segment_time(seconds)
            .ok_or("Preparing frame is outside the timeline")?;
        self.clock.video_ready(segment.recording_clip as usize)?;
        match pending.purpose {
            FramePurpose::Display {
                reply,
                settle_playing,
            } => {
                if self.handoff.committed() {
                    return self.publish();
                }
                (self.callback)(request, output, layout);
                self.clock.snapshot.progress.preview_available = true;
                self.clock.snapshot.playback.playhead_seconds = seconds;
                if let Some(playing) = settle_playing {
                    if playing {
                        if !self.start_audio().await? {
                            return Ok(());
                        }
                        self.start_clock()?;
                    } else {
                        self.clock.anchor = None;
                        self.clock.audio_position = None;
                        self.clock.snapshot.playback.playing = false;
                        self.clock.snapshot.playback.buffering = false;
                    }
                }
                self.publish()?;
                if let Some(reply) = reply {
                    let _ = reply.send(Ok(()));
                }
                return Ok(());
            }
            FramePurpose::Probe(index) => {
                if segment.recording_clip as usize != index {
                    return Err("Preparing probe did not resolve the requested clip".into());
                }
            }
        }
        self.publish()
    }

    async fn refresh_audio(&mut self) -> Result<(), String> {
        for (index, tracks) in self.audio.iter().enumerate() {
            for (track, audio) in tracks.iter().enumerate() {
                if self.completed_audio[index][track].is_some() {
                    continue;
                }
                if let Some(audio) = audio {
                    let progress = audio.loader().progress();
                    if let Some(error) = progress.error {
                        return Err(error);
                    }
                    if progress.complete {
                        self.completed_audio[index][track] = audio.loader().get().await?;
                    }
                }
            }
            if self.required_audio[index]
                .iter()
                .enumerate()
                .all(|(track, required)| !required || self.completed_audio[index][track].is_some())
            {
                self.clock.audio_ready(index)?;
            }
        }
        let prefix = self
            .audio_sources
            .as_ref()
            .ok_or("Preparing audio sources are absent")?
            .playable_prefix()?;
        self.clock.audio_prefix(prefix)?;
        if !self.handoff.ready()
            && self
                .required_audio
                .iter()
                .enumerate()
                .all(|(index, tracks)| {
                    tracks.iter().enumerate().all(|(track, required)| {
                        !required || self.completed_audio[index][track].is_some()
                    })
                })
        {
            for stop in &self.audio_stops {
                let exit = stop.wait().await;
                if !matches!(
                    exit.terminal,
                    cap_audio::ManagedAudioTerminal::Complete { .. }
                ) {
                    return Err(exit.terminal.to_string());
                }
            }
            let tracks = self
                .completed_audio
                .iter()
                .map(
                    |[mic, system_audio]| crate::completed_audio::CompletedAudioSegment {
                        mic: mic.clone(),
                        system_audio: system_audio.clone(),
                    },
                )
                .collect::<Vec<_>>();
            self.handoff
                .set_completed_identity(&tracks, &self.audio_output);
            let completed = crate::CompletedAudioHandoff::from_completed_tracks(
                &self.source_metadata,
                &self.expected_finalized_metadata,
                tracks,
            )?;
            self.handoff.complete(completed);
        }
        Ok(())
    }

    fn start_clock(&mut self) -> Result<(), String> {
        self.clock.start(Instant::now())?;
        if self
            .audio_ticket
            .as_ref()
            .and_then(|ticket| ticket.output_status(Instant::now()))
            .is_some()
        {
            self.clock.anchor = None;
        }
        Ok(())
    }

    async fn start_audio(&mut self) -> Result<bool, String> {
        self.stop_audio().await?;
        if self.cancelled.is_cancelled() {
            return Ok(false);
        }
        let position = self.clock.snapshot.playback.playhead_seconds;
        if !self
            .required_audio
            .iter()
            .flatten()
            .any(|required| *required)
        {
            return Ok(true);
        }
        let sources = self
            .audio_sources
            .as_ref()
            .ok_or("Preparing audio sources are absent")?
            .clone();
        self.audio_ticket = Some(self.audio_output.prepare_progressive_playback(
            sources,
            position,
            self.clock.snapshot.progress.playable_until,
        ));
        let started = tokio::select! {
            biased;
            _ = self.cancelled.cancelled() => false,
            started = self.audio_ticket.as_ref().expect("Preparing audio ticket is retained").wait_started() => started,
        };
        if !started || self.cancelled.is_cancelled() {
            let status = self
                .audio_ticket
                .as_ref()
                .and_then(|ticket| ticket.output_status(Instant::now()));
            self.stop_audio().await?;
            if !self.cancelled.is_cancelled()
                && let Some(status) = status
            {
                return Err(status
                    .error
                    .unwrap_or_else(|| "Preparing audio did not start".into()));
            }
        }
        Ok(!self.cancelled.is_cancelled())
    }

    async fn command(&mut self, command: PreparingPlaybackCommand) -> Result<(), String> {
        match command {
            PreparingPlaybackCommand::Seek(seconds, reply) => {
                let was_playing = self.clock.snapshot.playback.playing;
                if let Err(error) = self.clock.validate_seek(seconds) {
                    let _ = reply.send(Err(error));
                    return Ok(());
                }
                let frame = (seconds * f64::from(self.options.fps)).floor() as u32;
                self.stop_audio().await?;
                self.clock.anchor = None;
                self.clock.audio_position = None;
                self.clock.snapshot.playback.buffering = was_playing;
                self.request(
                    frame,
                    FramePurpose::Display {
                        reply: Some(reply),
                        settle_playing: Some(was_playing),
                    },
                )?;
                self.publish()?;
            }
            PreparingPlaybackCommand::Playing(playing, reply) => {
                if playing {
                    if self.pending.as_ref().is_some_and(|pending| {
                        matches!(
                            pending.purpose,
                            FramePurpose::Display {
                                settle_playing: Some(_),
                                ..
                            }
                        )
                    }) {
                        let _ = reply.send(Err("Preparing seek is still being presented".into()));
                        return Ok(());
                    }
                    if self.clock.snapshot.playback.playing {
                        let _ = reply.send(Ok(()));
                        return Ok(());
                    }
                    if !self.clock.snapshot.progress.preview_available
                        || self.clock.snapshot.playback.playhead_seconds
                            >= self.clock.snapshot.progress.playable_until
                    {
                        let _ = reply.send(Err(
                            "Preparing playback is not ready at this position".into()
                        ));
                        return Ok(());
                    }
                    self.clock.snapshot.playback.playing = true;
                    self.clock.snapshot.playback.buffering = true;
                    self.clock.anchor = None;
                    self.clock.audio_position = None;
                    self.publish()?;
                    if !self.start_audio().await? {
                        return Ok(());
                    }
                    self.start_clock()?;
                } else {
                    if let Some(status) = self
                        .audio_ticket
                        .as_ref()
                        .and_then(|ticket| ticket.output_status(Instant::now()))
                    {
                        self.clock.sync_audio(&status)?;
                    }
                    let position = self.clock.position_at(Instant::now());
                    self.stop_audio().await?;
                    self.clock.pause();
                    if self.clock.snapshot.progress.playable_until > 0.0 {
                        let fps = f64::from(self.options.fps);
                        let last_frame =
                            (self.clock.snapshot.progress.playable_until * fps).ceil() as u32;
                        let frame =
                            ((position * fps).floor() as u32).min(last_frame.saturating_sub(1));
                        self.request(
                            frame,
                            FramePurpose::Display {
                                reply: Some(reply),
                                settle_playing: Some(false),
                            },
                        )?;
                        return self.publish();
                    }
                }
                self.publish()?;
                let _ = reply.send(Ok(()));
            }
        }
        Ok(())
    }

    async fn tick(&mut self) -> Result<(), String> {
        if self.handoff.committed()
            && self.clock.clips.iter().all(|clip| clip.video)
            && let Some(preview) = self.preview.take()
        {
            self.pending = None;
            let exit = preview.stop_handle().stop_and_wait().await;
            if matches!(exit.reason, crate::PreparingPreviewError::TaskJoin(_)) {
                self.preview_cleanup_failed = true;
                return Err("Preparing video handoff could not join its workers".into());
            }
        }
        if let Some(error) = self
            .preview
            .as_ref()
            .and_then(|preview| preview.stop_handle().terminal_error())
        {
            return Err(error.to_string());
        }
        let old_prefix = self.clock.snapshot.progress.playable_until;
        self.refresh_audio().await?;
        if let Some(ticket) = &self.audio_ticket {
            ticket.set_playable_until(self.clock.snapshot.progress.playable_until)?;
        }
        let now = Instant::now();
        let audio_status = self
            .audio_ticket
            .as_ref()
            .and_then(|ticket| ticket.output_status(now));
        let has_audio_clock = audio_status.is_some();
        if let Some(status) = audio_status {
            let ended = status.ended;
            let buffering = self.clock.snapshot.playback.buffering;
            self.clock.sync_audio(&status)?;
            if ended {
                self.stop_audio().await?;
            }
            if ended || buffering != self.clock.snapshot.playback.buffering {
                self.publish()?;
            }
        }
        if self.audio_ticket.is_none()
            && self.clock.snapshot.playback.playing
            && self.clock.snapshot.playback.buffering
            && self.pending.is_none()
            && self.clock.position_at(now) < self.clock.snapshot.progress.playable_until
        {
            if !self.start_audio().await? {
                return Ok(());
            }
            self.start_clock()?;
            self.publish()?;
        }
        let now = Instant::now();
        if !has_audio_clock && self.clock.reach_boundary(now) {
            self.publish()?;
        }
        if old_prefix != self.clock.snapshot.progress.playable_until {
            self.publish()?;
        }
        if self.pending.is_some() {
            return Ok(());
        }
        if let Some(index) = self.clock.clips.iter().position(|clip| !clip.video) {
            let start = if index == 0 {
                0.0
            } else {
                self.clock.clips[index - 1].end
            };
            let frame = (start * f64::from(self.options.fps)).ceil() as u32;
            let time = f64::from(frame) / f64::from(self.options.fps);
            if time < self.clock.clips[index].end
                && (self.handoff.committed()
                    || !self.clock.snapshot.playback.playing
                    || start <= self.clock.position_at(now) + 2.0)
            {
                self.request(frame, FramePurpose::Probe(index))?;
                return Ok(());
            }
        }
        if self.handoff.committed() {
            return self.publish();
        }
        if (self.clock.snapshot.playback.playing || has_audio_clock)
            && self.clock.snapshot.progress.playable_until > 0.0
        {
            let fps = f64::from(self.options.fps);
            let last_frame = (self.clock.snapshot.progress.playable_until * fps).ceil() as u32;
            let frame = ((self.clock.position_at(now) * fps).floor() as u32)
                .min(last_frame.saturating_sub(1));
            if f64::from(frame) / fps != self.clock.snapshot.playback.playhead_seconds {
                self.request(
                    frame,
                    FramePurpose::Display {
                        reply: None,
                        settle_playing: None,
                    },
                )?;
            }
        }
        Ok(())
    }
}

fn deliver_latest<T>(sender: &flume::Sender<T>, discard: &flume::Receiver<T>, value: T) {
    if let Err(flume::TrySendError::Full(value)) = sender.try_send(value) {
        drop(discard.try_recv());
        let _ = sender.try_send(value);
    }
}

impl Drop for PreparingPlaybackSession {
    fn drop(&mut self) {
        if !self.handoff.committed() {
            self.stop.cancel();
        }
    }
}

#[derive(Clone, Debug)]
pub struct PreparingPlaybackSnapshot {
    pub sequence: u64,
    pub progress: PreparingEditorProgress,
    pub playback: PreparingPlaybackState,
}

struct ClipReadiness {
    end: f64,
    video: bool,
    audio_until: f64,
}

struct PreparingPlaybackClock {
    clips: Vec<ClipReadiness>,
    snapshot: PreparingPlaybackSnapshot,
    anchor: Option<(Instant, f64)>,
    audio_position: Option<f64>,
}

impl PreparingPlaybackClock {
    fn new(durations: &[f64], has_audio: &[bool]) -> Result<Self, String> {
        if durations.is_empty() || durations.len() != has_audio.len() {
            return Err("Preparing clip layout does not match".into());
        }
        let mut total = 0.0;
        let mut clips = Vec::with_capacity(durations.len());
        for (&duration, &has_audio) in durations.iter().zip(has_audio) {
            let start = total;
            total += duration;
            if !duration.is_finite() || duration <= 0.0 || !total.is_finite() {
                return Err("Preparing duration is invalid".into());
            }
            clips.push(ClipReadiness {
                end: total,
                video: false,
                audio_until: if has_audio { start } else { total },
            });
        }
        Ok(Self {
            clips,
            snapshot: PreparingPlaybackSnapshot {
                sequence: 0,
                progress: PreparingEditorProgress {
                    total_duration: Some(total),
                    ..Default::default()
                },
                playback: PreparingPlaybackState::default(),
            },
            anchor: None,
            audio_position: None,
        })
    }

    fn refresh_prefix(&mut self) {
        let mut prefix = 0.0;
        for clip in &self.clips {
            if !clip.video {
                break;
            }
            prefix = clip.audio_until;
            if prefix < clip.end {
                break;
            }
        }
        self.snapshot.progress.playable_until = prefix;
    }

    fn video_ready(&mut self, index: usize) -> Result<(), String> {
        let clip = self
            .clips
            .get_mut(index)
            .ok_or("Preparing video clip is outside the timeline")?;
        clip.video = true;
        self.refresh_prefix();
        Ok(())
    }

    fn audio_ready(&mut self, index: usize) -> Result<(), String> {
        let clip = self
            .clips
            .get_mut(index)
            .ok_or("Preparing audio clip is outside the timeline")?;
        clip.audio_until = clip.end;
        self.refresh_prefix();
        Ok(())
    }

    fn audio_prefix(&mut self, prefix: f64) -> Result<(), String> {
        let total = self
            .snapshot
            .progress
            .total_duration
            .ok_or("Preparing duration is unavailable")?;
        if !prefix.is_finite() || prefix < 0.0 || prefix > total {
            return Err("Preparing audio prefix is outside the timeline".into());
        }
        let mut start = 0.0;
        for clip in &mut self.clips {
            clip.audio_until = clip.audio_until.max(prefix.clamp(start, clip.end));
            start = clip.end;
        }
        self.refresh_prefix();
        Ok(())
    }

    fn sync_audio(
        &mut self,
        status: &crate::preparing_audio::PreparingAudioOutputSnapshot,
    ) -> Result<(), String> {
        if let Some(error) = &status.error {
            return Err(error.clone());
        }
        let total = self
            .snapshot
            .progress
            .total_duration
            .ok_or("Preparing duration is unavailable")?;
        if self.snapshot.progress.phase != PreparingEditorPhase::Preparing
            || !status.playhead_seconds.is_finite()
            || status.playhead_seconds < 0.0
            || status.playhead_seconds > total
            || (status.ended && status.buffering)
        {
            return Err("Preparing audio position is invalid".into());
        }
        self.audio_position = Some(
            status
                .playhead_seconds
                .min(self.snapshot.progress.playable_until),
        );
        self.anchor = None;
        self.snapshot.playback.buffering = status.buffering;
        if status.ended {
            self.snapshot.playback.playing = false;
        }
        Ok(())
    }

    fn position_at(&self, now: Instant) -> f64 {
        let position = self.anchor.map_or_else(
            || {
                self.audio_position
                    .unwrap_or(self.snapshot.playback.playhead_seconds)
            },
            |(start, at)| at + now.saturating_duration_since(start).as_secs_f64(),
        );
        position.min(self.snapshot.progress.playable_until)
    }

    fn start(&mut self, now: Instant) -> Result<(), String> {
        let position = self.position_at(now);
        if self.snapshot.progress.phase != PreparingEditorPhase::Preparing
            || !self.snapshot.progress.preview_available
            || position >= self.snapshot.progress.playable_until
        {
            return Err("Preparing playback is not ready at this position".into());
        }
        self.anchor = Some((now, position));
        self.audio_position = None;
        self.snapshot.playback.playing = true;
        self.snapshot.playback.buffering = false;
        Ok(())
    }

    fn pause(&mut self) {
        self.snapshot.playback.playing = false;
        self.snapshot.playback.buffering = false;
        self.anchor = None;
        self.audio_position = None;
    }

    fn validate_seek(&self, seconds: f64) -> Result<(), String> {
        if self.snapshot.progress.phase != PreparingEditorPhase::Preparing
            || !seconds.is_finite()
            || seconds < 0.0
            || seconds >= self.snapshot.progress.playable_until
        {
            return Err("Requested position is outside the playable recording".into());
        }
        Ok(())
    }

    fn reach_boundary(&mut self, now: Instant) -> bool {
        if !self.snapshot.playback.playing
            || self.snapshot.playback.buffering
            || self.position_at(now) < self.snapshot.progress.playable_until
        {
            return false;
        }
        self.anchor = None;
        self.audio_position = Some(self.snapshot.progress.playable_until);
        let at_end =
            self.snapshot.progress.total_duration == Some(self.snapshot.progress.playable_until);
        self.snapshot.playback.playing = !at_end;
        self.snapshot.playback.buffering = !at_end;
        true
    }

    fn handoff(&mut self) {
        self.anchor = None;
        self.audio_position = None;
        self.snapshot.progress.phase = PreparingEditorPhase::Handoff;
        self.snapshot.playback.buffering = false;
    }

    fn publish(&mut self) -> Result<PreparingPlaybackSnapshot, String> {
        self.snapshot.sequence = self
            .snapshot
            .sequence
            .checked_add(1)
            .ok_or("Preparing update sequence exhausted")?;
        Ok(self.snapshot.clone())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn expected_audio_metadata_only_allows_gap_summary_clearing() {
        let source: cap_project::RecordingMeta = serde_json::from_value(serde_json::json!({
            "pretty_name": "Stopped capture",
            "segments": [{
                "display": { "path": "display", "fps": 30 },
                "mic": {
                    "path": "audio-input.m4a", "start_time": 0.125,
                    "gap_summary": {
                        "total_overlap_trimmed_ms": 5,
                        "startup_overlap_trimmed_ms": 0,
                        "overlap_dropped_frames": 0,
                        "startup_overlap_drops": 0
                    }
                }
            }]
        }))
        .unwrap();
        validate_expected_metadata(&source, &source).unwrap();
        let mut cleared = serde_json::to_value(&source).unwrap();
        cleared["segments"][0]["mic"]
            .as_object_mut()
            .unwrap()
            .remove("gap_summary");
        let expected: cap_project::RecordingMeta = serde_json::from_value(cleared.clone()).unwrap();
        validate_expected_metadata(&source, &expected).unwrap();
        for field in ["path", "start_time", "device_id"] {
            let mut changed = cleared.clone();
            changed["segments"][0]["mic"][field] = if field == "start_time" {
                serde_json::json!(0.5)
            } else {
                serde_json::json!("changed")
            };
            let changed = serde_json::from_value(changed).unwrap();
            assert!(validate_expected_metadata(&source, &changed).is_err());
        }
        let mut changed = expected;
        changed.project_path = "another.cap".into();
        assert!(validate_expected_metadata(&source, &changed).is_err());
        let mut changed = serde_json::to_value(&source).unwrap();
        changed["segments"][0]["mic"]["gap_summary"]["total_overlap_trimmed_ms"] =
            serde_json::json!(9);
        let changed = serde_json::from_value(changed).unwrap();
        assert!(validate_expected_metadata(&source, &changed).is_err());
    }

    #[test]
    fn saturated_frame_delivery_retains_the_newest_seek_response() {
        let (frames, received) = flume::bounded(1);
        let discard = received.clone();
        for sequence in 1..=100 {
            deliver_latest(&frames, &discard, sequence);
        }
        assert_eq!(received.try_recv().unwrap(), 100);
        assert!(received.try_recv().is_err());
        deliver_latest(&frames, &discard, 101);
        assert_eq!(received.try_recv().unwrap(), 101);
    }

    #[test]
    fn readiness_never_skips_an_unready_clip_or_required_audio() {
        let mut clock =
            PreparingPlaybackClock::new(&[10.0, 20.0, 30.0], &[true, true, false]).unwrap();
        clock.video_ready(2).unwrap();
        clock.audio_ready(1).unwrap();
        clock.video_ready(1).unwrap();
        clock.video_ready(0).unwrap();
        assert_eq!(clock.snapshot.progress.playable_until, 0.0);
        clock.audio_ready(0).unwrap();
        assert_eq!(clock.snapshot.progress.playable_until, 60.0);
    }

    #[test]
    fn preview_and_wall_time_cannot_admit_playback() {
        let mut clock = PreparingPlaybackClock::new(&[7_200.0], &[true]).unwrap();
        clock.snapshot.progress.preview_available = true;
        clock.video_ready(0).unwrap();
        let now = Instant::now();
        assert!(clock.start(now).is_err());
        assert_eq!(clock.position_at(now + Duration::from_secs(7_200)), 0.0);
        assert!(clock.validate_seek(0.0).is_err());
    }

    #[test]
    fn buffering_freezes_clock_and_resumes_from_boundary_without_catching_up() {
        let mut clock = PreparingPlaybackClock::new(&[10.0, 20.0], &[false, false]).unwrap();
        clock.snapshot.progress.preview_available = true;
        clock.video_ready(0).unwrap();
        let now = Instant::now();
        clock.start(now).unwrap();
        clock.snapshot.playback.playhead_seconds = 9.5;
        assert!(clock.reach_boundary(now + Duration::from_secs(20)));
        assert_eq!(clock.position_at(now + Duration::from_secs(20)), 10.0);
        assert_eq!(clock.snapshot.playback.playhead_seconds, 9.5);
        assert!(clock.snapshot.playback.playing);
        assert!(clock.snapshot.playback.buffering);
        clock.video_ready(1).unwrap();
        assert_eq!(clock.position_at(now + Duration::from_secs(30)), 10.0);
        clock.start(now + Duration::from_secs(30)).unwrap();
        assert_eq!(clock.position_at(now + Duration::from_secs(31)), 11.0);
    }

    #[test]
    fn handoff_preserves_playing_intent_and_seeking_never_advances_beyond_prefix() {
        let mut clock = PreparingPlaybackClock::new(&[60.0], &[false]).unwrap();
        clock.snapshot.progress.preview_available = true;
        clock.video_ready(0).unwrap();
        for position in [f64::NAN, f64::INFINITY, -1.0, 60.0] {
            assert!(clock.validate_seek(position).is_err());
        }
        clock.validate_seek(12.25).unwrap();
        clock.snapshot.playback.playhead_seconds = 12.25;
        let now = Instant::now();
        clock.start(now).unwrap();
        clock.handoff();
        assert_eq!(clock.snapshot.playback.playhead_seconds, 12.25);
        assert!(clock.snapshot.playback.playing);
        assert_eq!(clock.snapshot.progress.phase, PreparingEditorPhase::Handoff);
        assert!(clock.validate_seek(0.0).is_err());
        assert!(clock.start(now).is_err());
    }

    #[test]
    fn reaching_the_complete_recording_end_pauses_without_buffering() {
        let mut clock = PreparingPlaybackClock::new(&[1.0], &[false]).unwrap();
        clock.snapshot.progress.preview_available = true;
        clock.video_ready(0).unwrap();
        let now = Instant::now();
        clock.start(now).unwrap();
        clock.snapshot.playback.playhead_seconds = 0.9;
        assert!(clock.reach_boundary(now + Duration::from_secs(2)));
        assert_eq!(clock.position_at(now + Duration::from_secs(2)), 1.0);
        assert_eq!(clock.snapshot.playback.playhead_seconds, 0.9);
        assert!(!clock.snapshot.playback.playing);
        assert!(!clock.snapshot.playback.buffering);
    }

    #[test]
    fn pause_and_update_sequence_preserve_the_confirmed_position() {
        let mut clock = PreparingPlaybackClock::new(&[60.0], &[false]).unwrap();
        clock.snapshot.progress.preview_available = true;
        clock.video_ready(0).unwrap();
        let now = Instant::now();
        clock.start(now).unwrap();
        clock.snapshot.playback.playhead_seconds = 3.0;
        clock.pause();
        assert_eq!(clock.position_at(now + Duration::from_secs(30)), 3.0);
        assert_eq!(clock.publish().unwrap().sequence, 1);
        assert_eq!(clock.publish().unwrap().sequence, 2);
    }

    fn audio_status(
        position: f64,
        buffering: bool,
        ended: bool,
    ) -> crate::preparing_audio::PreparingAudioOutputSnapshot {
        crate::preparing_audio::PreparingAudioOutputSnapshot {
            playhead_seconds: position,
            buffering,
            ended,
            error: None,
        }
    }

    #[test]
    fn partial_audio_admits_a_long_clip_only_after_its_video_is_ready() {
        let mut clock = PreparingPlaybackClock::new(&[7200.0], &[true]).unwrap();
        clock.audio_prefix(0.25).unwrap();
        assert_eq!(clock.snapshot.progress.playable_until, 0.0);
        clock.video_ready(0).unwrap();
        assert_eq!(clock.snapshot.progress.playable_until, 0.25);
        clock.audio_prefix(60.0).unwrap();
        clock.audio_prefix(0.5).unwrap();
        assert_eq!(clock.snapshot.progress.playable_until, 60.0);
        for prefix in [f64::NAN, f64::INFINITY, -1.0, 7200.01] {
            assert!(clock.audio_prefix(prefix).is_err());
            assert_eq!(clock.snapshot.progress.playable_until, 60.0);
        }
    }

    #[test]
    fn partial_audio_prefix_preserves_contiguous_video_and_silent_clip_gates() {
        let mut clock =
            PreparingPlaybackClock::new(&[5.0, 5.0, 5.0], &[false, true, false]).unwrap();
        clock.audio_prefix(8.0).unwrap();
        clock.video_ready(2).unwrap();
        clock.video_ready(1).unwrap();
        assert_eq!(clock.snapshot.progress.playable_until, 0.0);
        clock.video_ready(0).unwrap();
        assert_eq!(clock.snapshot.progress.playable_until, 8.0);
        clock.audio_prefix(10.0).unwrap();
        assert_eq!(clock.snapshot.progress.playable_until, 15.0);
    }

    #[test]
    fn audible_starvation_and_resume_never_advance_the_presented_frame_or_wall_clock() {
        let mut clock = PreparingPlaybackClock::new(&[7200.0], &[true]).unwrap();
        clock.snapshot.progress.preview_available = true;
        clock.snapshot.playback.playhead_seconds = 1.0;
        clock.audio_prefix(20.0).unwrap();
        clock.video_ready(0).unwrap();
        let now = Instant::now();
        clock.start(now).unwrap();
        clock.sync_audio(&audio_status(1.5, true, false)).unwrap();
        assert_eq!(clock.position_at(now + Duration::from_secs(100)), 1.5);
        assert_eq!(clock.snapshot.playback.playhead_seconds, 1.0);
        assert!(clock.snapshot.playback.playing);
        assert!(clock.snapshot.playback.buffering);
        clock.audio_prefix(40.0).unwrap();
        clock.sync_audio(&audio_status(1.75, false, false)).unwrap();
        assert_eq!(clock.position_at(now + Duration::from_secs(200)), 1.75);
        assert_eq!(clock.snapshot.playback.playhead_seconds, 1.0);
        assert!(clock.snapshot.playback.playing);
        assert!(!clock.snapshot.playback.buffering);
        clock.audio_prefix(7200.0).unwrap();
        clock
            .sync_audio(&audio_status(7200.0, false, true))
            .unwrap();
        assert!(!clock.snapshot.playback.playing);
        assert!(!clock.snapshot.playback.buffering);
        assert_eq!(clock.snapshot.playback.playhead_seconds, 1.0);
    }

    #[test]
    fn pause_and_handoff_discard_audible_ahead_position_but_retain_the_presented_frame() {
        let mut clock = PreparingPlaybackClock::new(&[10.0], &[true]).unwrap();
        clock.snapshot.progress.preview_available = true;
        clock.snapshot.playback.playhead_seconds = 3.0;
        clock.audio_prefix(10.0).unwrap();
        clock.video_ready(0).unwrap();
        let now = Instant::now();
        clock.start(now).unwrap();
        clock.sync_audio(&audio_status(3.2, false, false)).unwrap();
        clock.pause();
        assert_eq!(clock.position_at(now + Duration::from_secs(100)), 3.0);
        clock.start(now + Duration::from_secs(100)).unwrap();
        assert_eq!(clock.position_at(now + Duration::from_secs(100)), 3.0);
        clock.sync_audio(&audio_status(3.3, false, false)).unwrap();
        clock.handoff();
        assert_eq!(clock.position_at(now + Duration::from_secs(200)), 3.0);
        assert_eq!(clock.snapshot.playback.playhead_seconds, 3.0);
        assert!(clock.snapshot.playback.playing);
        assert!(clock.sync_audio(&audio_status(3.4, false, false)).is_err());
    }

    #[test]
    fn invalid_audio_status_cannot_mutate_the_clock_and_valid_status_clamps_to_prefix() {
        let mut clock = PreparingPlaybackClock::new(&[10.0], &[true]).unwrap();
        clock.snapshot.progress.preview_available = true;
        clock.audio_prefix(5.0).unwrap();
        clock.video_ready(0).unwrap();
        let now = Instant::now();
        clock.start(now).unwrap();
        clock.sync_audio(&audio_status(6.0, false, false)).unwrap();
        assert_eq!(clock.position_at(now), 5.0);
        assert_eq!(clock.snapshot.playback.playhead_seconds, 0.0);
        for status in [
            audio_status(f64::NAN, false, false),
            audio_status(f64::INFINITY, false, false),
            audio_status(-1.0, false, false),
            audio_status(10.1, false, false),
            audio_status(10.0, true, true),
            crate::preparing_audio::PreparingAudioOutputSnapshot {
                error: Some("late source failure".into()),
                ..audio_status(6.5, false, false)
            },
        ] {
            assert!(clock.sync_audio(&status).is_err());
            assert_eq!(clock.position_at(now + Duration::from_secs(60)), 5.0);
            assert_eq!(clock.snapshot.playback.playhead_seconds, 0.0);
        }
    }
}
