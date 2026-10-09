use super::preparing_projection::{
    PreparingAudioInput, PreparingProjection, PreparingStudioSegment, PreparingVideoInput,
};
use crate::studio_recording::{CleanStoppedStudioClaim, CompletedRecording};
use cap_enc_ffmpeg::RelocatableSource;
use cap_project::{AudioMeta, ProjectConfiguration, RecordingMeta, VideoMeta};
use std::{
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
};
use tokio::sync::watch;
use uuid::Uuid;

#[derive(Clone, Debug)]
pub struct PreparingStudioIdentity {
    shared: Arc<PreparingStudioIdentityState>,
}

#[derive(Debug)]
struct PreparingStudioIdentityState {
    project_path: PathBuf,
    generation: u64,
    job_id: Uuid,
    alive: AtomicBool,
    publication_succeeded: AtomicBool,
}

impl PreparingStudioIdentity {
    pub fn project_path(&self) -> &Path {
        &self.shared.project_path
    }

    pub fn generation(&self) -> u64 {
        self.shared.generation
    }

    pub fn job_id(&self) -> Uuid {
        self.shared.job_id
    }

    pub fn same_job(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.shared, &other.shared)
    }

    pub fn publication_succeeded(&self) -> bool {
        self.shared.publication_succeeded.load(Ordering::Acquire)
    }

    fn is_alive(&self) -> bool {
        self.shared.alive.load(Ordering::Acquire)
    }
}

#[derive(Clone)]
pub enum PreparingStudioState {
    Waiting,
    Available(Arc<PreparingStudioSources>),
    Unavailable(String),
    Ended,
}

#[derive(Clone)]
pub struct PreparingStudioObserver {
    identity: PreparingStudioIdentity,
    receiver: watch::Receiver<PreparingStudioState>,
}

impl PreparingStudioObserver {
    pub fn identity(&self) -> &PreparingStudioIdentity {
        &self.identity
    }

    pub fn same_job(&self, other: &Self) -> bool {
        self.identity.same_job(&other.identity)
    }

    pub fn publication_succeeded(&self) -> bool {
        self.identity.publication_succeeded()
    }

    pub fn latest(&self) -> PreparingStudioState {
        if self.identity.is_alive() {
            self.receiver.borrow().clone()
        } else {
            PreparingStudioState::Ended
        }
    }

    pub async fn changed(&mut self) -> PreparingStudioState {
        if !self.identity.is_alive() || self.receiver.changed().await.is_err() {
            return PreparingStudioState::Ended;
        }
        self.latest()
    }
}

#[cfg(test)]
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) enum PreparingStudioTestTransition {
    Available,
    Unavailable(String),
    Ended,
}

pub struct PreparingStudioJob {
    identity: PreparingStudioIdentity,
    claimed: Option<CleanStoppedStudioClaim>,
    sender: watch::Sender<PreparingStudioState>,
    #[cfg(test)]
    test_transitions: Arc<std::sync::Mutex<Vec<PreparingStudioTestTransition>>>,
}

impl PreparingStudioJob {
    pub fn claim(
        completed: &CompletedRecording,
        generation: u64,
    ) -> Option<(Self, PreparingStudioObserver)> {
        let claimed = completed
            .clean_stopped
            .as_ref()?
            .claim(&completed.project_path)?;
        let identity = PreparingStudioIdentity {
            shared: Arc::new(PreparingStudioIdentityState {
                project_path: claimed.metadata().project_path.clone(),
                generation,
                job_id: Uuid::new_v4(),
                alive: AtomicBool::new(true),
                publication_succeeded: AtomicBool::new(false),
            }),
        };
        let (sender, receiver) = watch::channel(PreparingStudioState::Waiting);
        let observer = PreparingStudioObserver {
            identity: identity.clone(),
            receiver,
        };
        Some((
            Self {
                identity,
                claimed: Some(claimed),
                sender,
                #[cfg(test)]
                test_transitions: Default::default(),
            },
            observer,
        ))
    }

    pub fn identity(&self) -> &PreparingStudioIdentity {
        &self.identity
    }

    pub fn observer(&self) -> PreparingStudioObserver {
        PreparingStudioObserver {
            identity: self.identity.clone(),
            receiver: self.sender.subscribe(),
        }
    }

    #[cfg(test)]
    pub(super) fn test_transitions(
        &self,
    ) -> Arc<std::sync::Mutex<Vec<PreparingStudioTestTransition>>> {
        self.test_transitions.clone()
    }

    #[cfg(test)]
    fn record_test_transition(&self, transition: PreparingStudioTestTransition) {
        self.test_transitions
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .push(transition);
    }

    pub(super) fn claimed(&self) -> Option<&CleanStoppedStudioClaim> {
        self.claimed.as_ref()
    }

    pub(super) fn mark_publication_succeeded(&mut self) {
        if self.identity.is_alive()
            && matches!(*self.sender.borrow(), PreparingStudioState::Available(_))
        {
            self.identity
                .shared
                .publication_succeeded
                .store(true, Ordering::Release);
        }
    }

    pub(super) fn unavailable(&mut self, reason: String) {
        if self.identity.is_alive()
            && matches!(*self.sender.borrow(), PreparingStudioState::Waiting)
        {
            #[cfg(test)]
            self.record_test_transition(PreparingStudioTestTransition::Unavailable(reason.clone()));
            drop(
                self.sender
                    .send_replace(PreparingStudioState::Unavailable(reason)),
            );
        }
    }

    pub(super) fn publish(
        &mut self,
        source: RelocatableSource,
        projection: PreparingProjection,
    ) -> bool {
        if !self.identity.is_alive()
            || !matches!(*self.sender.borrow(), PreparingStudioState::Waiting)
        {
            return false;
        }
        let Some(claimed) = self.claimed.take() else {
            return false;
        };
        let sources = Arc::new(PreparingStudioSources {
            identity: self.identity.clone(),
            claimed,
            projection,
            source,
        });
        drop(
            self.sender
                .send_replace(PreparingStudioState::Available(sources)),
        );
        #[cfg(test)]
        self.record_test_transition(PreparingStudioTestTransition::Available);
        true
    }
}

impl Drop for PreparingStudioJob {
    fn drop(&mut self) {
        self.identity.shared.alive.store(false, Ordering::Release);
        drop(self.sender.send_replace(PreparingStudioState::Ended));
        #[cfg(test)]
        self.record_test_transition(PreparingStudioTestTransition::Ended);
    }
}

pub struct PreparingStudioSources {
    identity: PreparingStudioIdentity,
    claimed: CleanStoppedStudioClaim,
    projection: PreparingProjection,
    source: RelocatableSource,
}

impl PreparingStudioSources {
    pub fn identity(&self) -> &PreparingStudioIdentity {
        &self.identity
    }

    pub fn live(&self) -> Option<LivePreparingStudioSources<'_>> {
        self.identity
            .is_alive()
            .then_some(LivePreparingStudioSources { sources: self })
    }
}

pub struct LivePreparingStudioSources<'a> {
    sources: &'a PreparingStudioSources,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PreparingVideoTrack {
    Display,
    Camera,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PreparingAudioTrack {
    Mic,
    SystemAudio,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PreparingSidecarKind {
    Cursor,
    Keyboard,
}

impl<'a> LivePreparingStudioSources<'a> {
    pub fn identity(&self) -> &PreparingStudioIdentity {
        self.sources.identity()
    }

    pub fn metadata(&self) -> Option<&'a RecordingMeta> {
        self.sources
            .identity
            .is_alive()
            .then_some(self.sources.claimed.metadata())
    }

    pub fn configuration(&self) -> Option<&'a ProjectConfiguration> {
        self.sources
            .identity
            .is_alive()
            .then_some(self.sources.claimed.configuration())
    }

    pub fn configuration_bytes(&self) -> Option<&'a [u8]> {
        self.sources
            .identity
            .is_alive()
            .then_some(self.sources.projection.configuration_bytes.as_slice())
    }

    pub fn segments(&self) -> Option<&'a [PreparingStudioSegment]> {
        self.sources
            .identity
            .is_alive()
            .then_some(self.sources.projection.segments.as_slice())
    }

    pub fn video(&self, index: u32, track: PreparingVideoTrack) -> Option<PreparingVideoLease<'a>> {
        let segment = self
            .segments()?
            .iter()
            .find(|segment| segment.index() == index)?;
        let descriptor = match track {
            PreparingVideoTrack::Display => segment.display(),
            PreparingVideoTrack::Camera => segment.camera()?,
        };
        self.sources
            .identity
            .is_alive()
            .then(|| PreparingVideoLease {
                identity: self.sources.identity.clone(),
                source: self.sources.source.clone(),
                descriptor,
            })
    }

    pub fn audio(&self, index: u32, track: PreparingAudioTrack) -> Option<PreparingAudioLease<'a>> {
        let segment = self
            .segments()?
            .iter()
            .find(|segment| segment.index() == index)?;
        let descriptor = match track {
            PreparingAudioTrack::Mic => segment.mic()?,
            PreparingAudioTrack::SystemAudio => segment.system_audio()?,
        };
        self.sources
            .identity
            .is_alive()
            .then(|| PreparingAudioLease {
                identity: self.sources.identity.clone(),
                source: self.sources.source.clone(),
                descriptor,
            })
    }

    pub fn sidecar(
        &self,
        index: u32,
        kind: PreparingSidecarKind,
    ) -> Option<PreparingSidecarLease<'a>> {
        let segment = self
            .segments()?
            .iter()
            .find(|segment| segment.index() == index)?;
        let path = match kind {
            PreparingSidecarKind::Cursor => segment.cursor_path()?,
            PreparingSidecarKind::Keyboard => segment.keyboard_path()?,
        };
        self.sources
            .identity
            .is_alive()
            .then(|| PreparingSidecarLease {
                identity: self.sources.identity.clone(),
                source: self.sources.source.clone(),
                path,
            })
    }
}

pub struct PreparingVideoLease<'a> {
    identity: PreparingStudioIdentity,
    source: RelocatableSource,
    descriptor: &'a PreparingVideoInput,
}

impl PreparingVideoLease<'_> {
    pub fn input(&self) -> Option<(&RelocatableSource, &[PathBuf])> {
        self.identity
            .is_alive()
            .then_some((&self.source, self.descriptor.paths()))
    }

    pub fn metadata(&self) -> Option<&VideoMeta> {
        self.identity
            .is_alive()
            .then_some(self.descriptor.metadata())
    }
}

pub struct PreparingAudioLease<'a> {
    identity: PreparingStudioIdentity,
    source: RelocatableSource,
    descriptor: &'a PreparingAudioInput,
}

impl PreparingAudioLease<'_> {
    pub fn input(&self) -> Option<(&RelocatableSource, &Path)> {
        self.identity
            .is_alive()
            .then_some((&self.source, self.descriptor.path()))
    }

    pub fn metadata(&self) -> Option<&AudioMeta> {
        self.identity
            .is_alive()
            .then_some(self.descriptor.metadata())
    }
}

pub struct PreparingSidecarLease<'a> {
    identity: PreparingStudioIdentity,
    source: RelocatableSource,
    path: &'a Path,
}

impl PreparingSidecarLease<'_> {
    pub fn input(&self) -> Option<(&RelocatableSource, &Path)> {
        self.identity
            .is_alive()
            .then_some((&self.source, self.path))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::studio_recording::CleanStoppedStudio;
    use cap_project::{
        MultipleSegment, MultipleSegments, Platform, RecordingMetaInner, StudioRecordingMeta,
        StudioRecordingStatus,
    };
    use std::io::Read;

    struct Dropped(Arc<AtomicBool>);

    impl Drop for Dropped {
        fn drop(&mut self) {
            self.0.store(true, Ordering::Release);
        }
    }

    fn segment() -> MultipleSegment {
        MultipleSegment {
            display: VideoMeta {
                path: "content/segments/media".into(),
                fps: 30,
                start_time: Some(0.25),
                device_id: None,
            },
            camera: None,
            mic: None,
            system_audio: None,
            cursor: None,
            keyboard: None,
            display_notch: None,
        }
    }

    fn completed(path: &Path) -> CompletedRecording {
        let metadata = RecordingMeta {
            platform: Some(Platform::default()),
            project_path: path.to_path_buf(),
            pretty_name: "Preparing observer fixture".to_string(),
            sharing: None,
            inner: RecordingMetaInner::Studio(Box::new(StudioRecordingMeta::MultipleSegments {
                inner: MultipleSegments {
                    segments: vec![segment()],
                    cursors: cap_project::Cursors::Correct(Default::default()),
                    status: Some(StudioRecordingStatus::NeedsRemux),
                },
            })),
            upload: None,
        };
        let RecordingMetaInner::Studio(studio) = &metadata.inner else {
            unreachable!();
        };
        CompletedRecording {
            project_path: path.to_path_buf(),
            meta: studio.as_ref().clone(),
            cursor_data: Default::default(),
            clean_stopped: CleanStoppedStudio::for_test(metadata, ProjectConfiguration::default()),
        }
    }

    fn publication(root: &Path) -> (RelocatableSource, PreparingProjection, Arc<AtomicBool>) {
        std::fs::create_dir_all(root.join("media")).unwrap();
        std::fs::write(root.join("media/init.mp4"), b"init-contents").unwrap();
        std::fs::write(root.join("media/one.m4s"), b"fragment-contents").unwrap();
        let dropped = Arc::new(AtomicBool::new(false));
        let source = RelocatableSource::new_with_owner(
            root.to_path_buf(),
            Arc::new(Dropped(dropped.clone())),
        )
        .unwrap();
        let projection = PreparingProjection::for_test(
            segment(),
            vec!["media/init.mp4".into(), "media/one.m4s".into()],
            b"{\"fixture\":true}".to_vec(),
        );
        (source, projection, dropped)
    }

    fn available(observer: &PreparingStudioObserver) -> Arc<PreparingStudioSources> {
        match observer.latest() {
            PreparingStudioState::Available(sources) => sources,
            _ => panic!("Expected preparing sources"),
        }
    }

    #[test]
    fn completion_receipt_claim_is_one_shot_and_wrong_path_does_not_consume_it() {
        let completion = completed(Path::new("same.cap"));
        let mut wrong_path = completion.clone();
        wrong_path.project_path = PathBuf::from("different.cap");
        assert!(PreparingStudioJob::claim(&wrong_path, 1).is_none());
        let (job, observer) = PreparingStudioJob::claim(&completion, 1).unwrap();
        assert!(PreparingStudioJob::claim(&completion.clone(), 2).is_none());
        assert!(job.claimed().is_some());
        assert_eq!(job.identity().project_path(), Path::new("same.cap"));
        assert_eq!(observer.identity().generation(), 1);
        assert!(observer.same_job(&observer.clone()));
        let mut reconstructed = completion.clone();
        reconstructed.clean_stopped = None;
        assert!(PreparingStudioJob::claim(&reconstructed, 3).is_none());
    }

    #[test]
    fn separate_jobs_with_same_project_and_generation_have_distinct_identity() {
        let first = completed(Path::new("same.cap"));
        let second = completed(Path::new("same.cap"));
        let third = completed(Path::new("same.cap"));
        let (first_job, first_observer) = PreparingStudioJob::claim(&first, 7).unwrap();
        let (second_job, second_observer) = PreparingStudioJob::claim(&second, 7).unwrap();
        let (third_job, third_observer) = PreparingStudioJob::claim(&third, 8).unwrap();
        assert!(!first_observer.same_job(&second_observer));
        assert!(!first_observer.same_job(&third_observer));
        assert_ne!(
            first_job.identity().job_id(),
            second_job.identity().job_id()
        );
        assert_ne!(
            first_job.identity().generation(),
            third_job.identity().generation()
        );
        assert!(first_observer.identity().same_job(first_job.identity()));
    }

    #[tokio::test]
    async fn late_observer_sees_retained_available_and_then_ended() {
        let directory = tempfile::tempdir().unwrap();
        let completion = completed(directory.path());
        let (mut job, mut early) = PreparingStudioJob::claim(&completion, 9).unwrap();
        assert!(matches!(early.latest(), PreparingStudioState::Waiting));
        let (source, projection, _) = publication(&directory.path().join("segments"));
        assert!(job.publish(source, projection));
        assert!(job.claimed().is_none());
        assert!(matches!(
            early.changed().await,
            PreparingStudioState::Available(_)
        ));
        let mut late = job.observer();
        let early_sources = available(&early);
        let late_sources = available(&late);
        assert!(Arc::ptr_eq(&early_sources, &late_sources));
        assert!(early.same_job(&late));
        drop(job);
        assert!(matches!(late.changed().await, PreparingStudioState::Ended));
        assert!(matches!(early.latest(), PreparingStudioState::Ended));
        assert!(!early.publication_succeeded());
        assert!(early_sources.live().is_none());
    }

    #[test]
    fn publication_retains_sources_without_any_observer_receivers() {
        let directory = tempfile::tempdir().unwrap();
        let completion = completed(directory.path());
        let (mut job, observer) = PreparingStudioJob::claim(&completion, 10).unwrap();
        drop(observer);
        assert_eq!(job.sender.receiver_count(), 0);
        let (source, projection, dropped) = publication(&directory.path().join("segments"));
        assert!(job.publish(source, projection));
        assert!(!dropped.load(Ordering::Acquire));
        let late = job.observer();
        let sources = available(&late);
        assert!(sources.live().is_some());
        let weak = Arc::downgrade(&sources);
        drop(sources);
        drop(job);
        assert!(matches!(late.latest(), PreparingStudioState::Ended));
        assert!(weak.upgrade().is_none());
        assert!(dropped.load(Ordering::Acquire));
    }

    #[test]
    fn unavailable_keeps_finalization_identity_alive_without_publishing_later() {
        let directory = tempfile::tempdir().unwrap();
        let completion = completed(directory.path());
        let (mut job, observer) = PreparingStudioJob::claim(&completion, 11).unwrap();
        job.unavailable("Unsupported input grouping".to_string());
        assert!(job.identity.is_alive());
        assert!(job.claimed().is_some());
        assert!(
            matches!(observer.latest(), PreparingStudioState::Unavailable(reason) if reason == "Unsupported input grouping")
        );
        let late = job.observer();
        assert!(matches!(
            late.latest(),
            PreparingStudioState::Unavailable(_)
        ));
        let (source, projection, dropped) = publication(&directory.path().join("segments"));
        assert!(!job.publish(source, projection));
        assert!(dropped.load(Ordering::Acquire));
        assert!(matches!(
            observer.latest(),
            PreparingStudioState::Unavailable(_)
        ));
        drop(job);
        assert!(matches!(observer.latest(), PreparingStudioState::Ended));
    }

    #[test]
    fn revoked_views_and_leases_reject_new_access_but_existing_reader_keeps_owner() {
        let directory = tempfile::tempdir().unwrap();
        let completion = completed(directory.path());
        let (mut job, observer) = PreparingStudioJob::claim(&completion, 12).unwrap();
        let identity = Arc::downgrade(&job.identity.shared);
        let (source, projection, dropped) = publication(&directory.path().join("segments"));
        assert!(job.publish(source, projection));
        let sources = available(&observer);
        let source_weak = Arc::downgrade(&sources);
        let mut reader = {
            let live = sources.live().unwrap();
            assert_eq!(live.metadata().unwrap().project_path, directory.path());
            assert!(live.configuration().is_some());
            assert_eq!(live.configuration_bytes().unwrap(), b"{\"fixture\":true}");
            assert_eq!(live.segments().unwrap().len(), 1);
            assert!(live.video(1, PreparingVideoTrack::Display).is_none());
            assert!(live.video(0, PreparingVideoTrack::Camera).is_none());
            assert!(live.audio(0, PreparingAudioTrack::Mic).is_none());
            assert!(live.audio(0, PreparingAudioTrack::SystemAudio).is_none());
            assert!(live.sidecar(0, PreparingSidecarKind::Cursor).is_none());
            assert!(live.sidecar(0, PreparingSidecarKind::Keyboard).is_none());
            let lease = live.video(0, PreparingVideoTrack::Display).unwrap();
            assert_eq!(lease.metadata().unwrap().fps, 30);
            let (source, paths) = lease.input().unwrap();
            assert_eq!(
                paths,
                &[
                    PathBuf::from("media/init.mp4"),
                    PathBuf::from("media/one.m4s")
                ]
            );
            let mut reader = source.reader(&paths[0]).unwrap();
            let mut prefix = [0_u8; 4];
            reader.read_exact(&mut prefix).unwrap();
            assert_eq!(&prefix, b"init");
            drop(job);
            assert!(sources.live().is_none());
            assert!(live.metadata().is_none());
            assert!(live.configuration().is_none());
            assert!(live.configuration_bytes().is_none());
            assert!(live.segments().is_none());
            assert!(live.video(0, PreparingVideoTrack::Display).is_none());
            assert!(lease.input().is_none());
            assert!(lease.metadata().is_none());
            reader
        };
        drop(sources);
        drop(observer);
        assert!(source_weak.upgrade().is_none());
        assert!(identity.upgrade().is_none());
        assert!(!dropped.load(Ordering::Acquire));
        let mut remaining = Vec::new();
        reader.read_to_end(&mut remaining).unwrap();
        assert_eq!(remaining, b"-contents");
        drop(reader);
        assert!(dropped.load(Ordering::Acquire));
    }

    #[test]
    fn unwinding_job_revokes_and_drops_watch_owned_source_without_cycle() {
        let directory = tempfile::tempdir().unwrap();
        let completion = completed(directory.path());
        let (mut job, observer) = PreparingStudioJob::claim(&completion, 13).unwrap();
        let (source, projection, dropped) = publication(&directory.path().join("segments"));
        assert!(job.publish(source, projection));
        let sources = available(&observer);
        let source_weak = Arc::downgrade(&sources);
        drop(sources);
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(move || {
            let _job = job;
            panic!("Preparing finalizer unwind probe");
        }));
        assert!(result.is_err());
        assert!(matches!(observer.latest(), PreparingStudioState::Ended));
        assert!(source_weak.upgrade().is_none());
        assert!(dropped.load(Ordering::Acquire));
    }

    #[tokio::test]
    async fn waiting_job_drop_wakes_changed_and_preserves_ended_for_clones() {
        let completion = completed(Path::new("waiting.cap"));
        let (job, mut observer) = PreparingStudioJob::claim(&completion, 14).unwrap();
        let mut changed = Box::pin(observer.changed());
        assert!(futures::poll!(&mut changed).is_pending());
        drop(job);
        assert!(matches!(changed.await, PreparingStudioState::Ended));
        let mut late = observer.clone();
        assert!(matches!(late.latest(), PreparingStudioState::Ended));
        assert!(matches!(late.changed().await, PreparingStudioState::Ended));
    }
    #[test]
    fn successful_publication_receipt_never_reopens_ended_admission() {
        let directory = tempfile::tempdir().unwrap();
        let completion = completed(directory.path());
        let (mut job, observer) = PreparingStudioJob::claim(&completion, 55).unwrap();
        job.mark_publication_succeeded();
        assert!(!observer.publication_succeeded());
        let (source, projection, _) = publication(&directory.path().join("segments"));
        assert!(job.publish(source, projection));
        let sources = available(&observer);
        job.mark_publication_succeeded();
        drop(job);
        assert!(observer.publication_succeeded());
        assert!(observer.identity().publication_succeeded());
        assert!(matches!(observer.latest(), PreparingStudioState::Ended));
        assert!(sources.live().is_none());
    }
}
