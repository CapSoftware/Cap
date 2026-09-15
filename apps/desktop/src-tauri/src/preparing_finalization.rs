use super::{
    FinalizationAttempt, FinalizationOrigin, FinalizationProject, FinalizationToken,
    FinalizingRecordings, FinalizingRecordingsMap,
};
use cap_recording::{
    recovery::{PreparingStudioJob, PreparingStudioObserver},
    studio_recording::CompletedRecording,
};
use std::sync::{Arc, Mutex};

#[derive(Clone, Default)]
pub(super) enum PreparingFinalizationState {
    #[default]
    Waiting,
    Declined,
    Offered(PreparingStudioObserver),
}

#[derive(Clone)]
pub(crate) struct FinalizationPreparing {
    recordings: Arc<Mutex<FinalizingRecordingsMap>>,
    attempt: Arc<FinalizationAttempt>,
}

impl FinalizationToken {
    pub(crate) fn preparing(&self) -> FinalizationPreparing {
        FinalizationPreparing {
            recordings: self.recordings.clone(),
            attempt: self.attempt.clone(),
        }
    }
}

impl FinalizingRecordings {
    pub(crate) fn preparing_for_project(
        &self,
        project: &FinalizationProject,
    ) -> Option<FinalizationPreparing> {
        let recordings = self.recordings.lock().unwrap();
        let attempt = recordings.attempts.get(&project.identity)?;
        if attempt.origin != FinalizationOrigin::Recording || attempt.result.borrow().is_some() {
            return None;
        }
        Some(FinalizationPreparing {
            recordings: self.recordings.clone(),
            attempt: attempt.clone(),
        })
    }
}

impl FinalizationPreparing {
    pub(crate) fn allows_preparing_continuation(&self) -> bool {
        let recordings = self.recordings.lock().unwrap();
        self.attempt.origin == FinalizationOrigin::Recording
            && recordings
                .attempts
                .get(&self.attempt.project.identity)
                .map_or_else(
                    || matches!(&*self.attempt.result.borrow(), Some(Ok(()))),
                    |current| Arc::ptr_eq(current, &self.attempt),
                )
            && self
                .attempt
                .result
                .borrow()
                .as_ref()
                .is_none_or(Result::is_ok)
            && matches!(&*self.attempt.preparing.borrow(), PreparingFinalizationState::Offered(observer) if observer.publication_succeeded())
    }

    pub(crate) fn is_pending(&self) -> bool {
        self.is_current(&self.recordings.lock().unwrap())
    }

    pub(crate) fn set_presentation(
        &self,
        presentation: Result<cap_project::ProjectConfiguration, String>,
    ) {
        let recordings = self.recordings.lock().unwrap();
        if self.is_current(&recordings) {
            self.attempt
                .preparing_presentation
                .send_if_modified(|state| {
                    if state.is_some() {
                        return false;
                    }
                    *state = Some(presentation.map(Arc::new));
                    true
                });
        }
    }

    pub(crate) async fn wait_for_presentation(
        &self,
    ) -> Option<Arc<cap_project::ProjectConfiguration>> {
        let mut presentation = self.attempt.preparing_presentation.subscribe();
        let mut result = self.attempt.result.subscribe();
        loop {
            let state = {
                let recordings = self.recordings.lock().unwrap();
                if !self.is_current(&recordings) {
                    return None;
                }
                presentation.borrow_and_update().clone()
            };
            if let Some(state) = state {
                return state.ok();
            }
            tokio::select! {
                changed = presentation.changed() => if changed.is_err() { return None; },
                changed = result.changed() => if changed.is_err() { return None; },
            }
        }
    }

    #[cfg(test)]
    fn same_attempt(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.attempt, &other.attempt)
    }

    fn is_current(&self, recordings: &FinalizingRecordingsMap) -> bool {
        self.attempt.origin == FinalizationOrigin::Recording
            && recordings
                .attempts
                .get(&self.attempt.project.identity)
                .is_some_and(|current| Arc::ptr_eq(current, &self.attempt))
            && self.attempt.result.borrow().is_none()
    }

    pub(crate) fn claim(&self, completed: &CompletedRecording) -> Option<PreparingStudioJob> {
        self.claim_with(completed, PreparingStudioJob::claim)
    }

    fn claim_with(
        &self,
        completed: &CompletedRecording,
        claim: impl FnOnce(
            &CompletedRecording,
            u64,
        ) -> Option<(PreparingStudioJob, PreparingStudioObserver)>,
    ) -> Option<PreparingStudioJob> {
        let paths_match = completed.project_path == self.attempt.project.display_path()
            && self.attempt.project.display_path() == self.attempt.project.work_path();
        let directory_valid = paths_match
            && self.attempt.preparing_generation.is_some()
            && self.attempt.project.validate().is_ok();
        let recordings = self.recordings.lock().unwrap();
        if !self.is_current(&recordings) {
            return None;
        }
        let mut job = None;
        self.attempt.preparing.send_if_modified(|state| {
            if !matches!(state, PreparingFinalizationState::Waiting) {
                return false;
            }
            *state = PreparingFinalizationState::Declined;
            if directory_valid
                && let Some(generation) = self.attempt.preparing_generation
                && let Some((claimed, observer)) = claim(completed, generation)
            {
                job = Some(claimed);
                *state = PreparingFinalizationState::Offered(observer);
            }
            true
        });
        job
    }

    pub(crate) async fn wait_for_preparing(&self) -> Option<PreparingStudioObserver> {
        let mut preparing = self.attempt.preparing.subscribe();
        let mut result = self.attempt.result.subscribe();
        loop {
            let state = {
                let recordings = self.recordings.lock().unwrap();
                if !self.is_current(&recordings) {
                    return None;
                }
                preparing.borrow_and_update().clone()
            };
            match state {
                PreparingFinalizationState::Waiting => {}
                PreparingFinalizationState::Declined => return None,
                PreparingFinalizationState::Offered(observer) => return Some(observer),
            }
            tokio::select! {
                changed = preparing.changed() => if changed.is_err() { return None; },
                changed = result.changed() => if changed.is_err() { return None; },
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{FinalizationAccess, await_finalization_result, has_pending_finalizations};
    use cap_project::RecordingMeta;
    use std::path::Path;
    use std::time::Duration;

    fn project() -> (tempfile::TempDir, Arc<FinalizationProject>) {
        let directory = tempfile::tempdir().unwrap();
        let project = FinalizationProject::capture(
            directory.path().canonicalize().unwrap(),
            FinalizationAccess::Write,
        )
        .unwrap();
        (directory, project)
    }

    async fn wait_for_preparing(
        preparing: &FinalizationPreparing,
    ) -> Option<PreparingStudioObserver> {
        tokio::time::timeout(Duration::from_secs(1), preparing.wait_for_preparing())
            .await
            .unwrap()
    }

    fn completed_without_receipt(path: &Path) -> CompletedRecording {
        let metadata: RecordingMeta = serde_json::from_value(serde_json::json!({
            "pretty_name": "Preparing finalization test", "sharing": null,
            "segments": [{"display": {"path": "content/segments/segment-0/display", "fps": 30}}],
            "status": {"status": "NeedsRemux"}
        }))
        .unwrap();
        CompletedRecording {
            project_path: path.to_path_buf(),
            meta: metadata.studio_meta().unwrap().clone(),
            cursor_data: Default::default(),
            clean_stopped: None,
        }
    }

    #[tokio::test]
    async fn declined_receipt_is_not_finalization_success() {
        let (_directory, project) = project();
        let recordings = FinalizingRecordings::default();
        let token = recordings.start_finalizing(project.clone()).unwrap();
        let preparing = recordings.preparing_for_project(&project).unwrap();
        assert!(preparing.same_attempt(&token.preparing()));
        assert!(
            preparing
                .claim(&completed_without_receipt(project.display_path()))
                .is_none()
        );
        assert!(wait_for_preparing(&preparing).await.is_none());
        assert!(has_pending_finalizations(
            &recordings.recordings.lock().unwrap()
        ));
        let result = token.attempt.result.subscribe();
        token.finish(Err("configuration write failed".into()));
        assert!(
            await_finalization_result(result)
                .await
                .unwrap_err()
                .contains("configuration write failed")
        );
        assert!(recordings.preparing_for_project(&project).is_none());
    }

    #[tokio::test]
    async fn completion_before_admission_does_not_invoke_claim() {
        let (_directory, project) = project();
        let recordings = FinalizingRecordings::default();
        let token = recordings.start_finalizing(project.clone()).unwrap();
        let preparing = token.preparing();
        token.finish(Ok(()));
        assert!(
            preparing
                .claim_with(
                    &completed_without_receipt(project.display_path()),
                    |_, _| panic!("Completed attempts cannot claim")
                )
                .is_none()
        );
        assert!(wait_for_preparing(&preparing).await.is_none());
        assert!(!has_pending_finalizations(
            &recordings.recordings.lock().unwrap()
        ));
    }

    #[tokio::test]
    async fn failed_retry_has_a_new_attempt_and_rejects_stale_claims() {
        let (_directory, project) = project();
        let recordings = FinalizingRecordings::default();
        let first = recordings.start_finalizing(project.clone()).unwrap();
        assert_eq!(first.attempt.preparing_generation, Some(1));
        let stale = first.preparing();
        first.finish(Err("first failure".into()));
        let second = recordings.start_finalizing(project.clone()).unwrap();
        assert_eq!(second.attempt.preparing_generation, Some(2));
        let current = second.preparing();
        assert!(!stale.same_attempt(&current));
        assert!(
            stale
                .claim_with(
                    &completed_without_receipt(project.display_path()),
                    |_, _| panic!("Stale attempts cannot claim")
                )
                .is_none()
        );
        assert!(wait_for_preparing(&stale).await.is_none());
        assert!(
            tokio::time::timeout(Duration::from_millis(20), current.wait_for_preparing())
                .await
                .is_err()
        );
        second.finish(Ok(()));
        assert!(wait_for_preparing(&current).await.is_none());
    }

    #[tokio::test]
    async fn token_drop_wakes_pending_observer_and_preserves_interrupted_error() {
        let (_directory, project) = project();
        let recordings = FinalizingRecordings::default();
        let token = recordings.start_finalizing(project).unwrap();
        let preparing = token.preparing();
        let result = token.attempt.result.subscribe();
        assert!(
            tokio::time::timeout(Duration::from_millis(20), preparing.wait_for_preparing())
                .await
                .is_err()
        );
        drop(token);
        assert!(
            tokio::time::timeout(Duration::from_secs(1), preparing.wait_for_preparing())
                .await
                .unwrap()
                .is_none()
        );
        assert!(
            await_finalization_result(result)
                .await
                .unwrap_err()
                .contains("interrupted")
        );
    }

    #[test]
    fn native_recording_attempt_allocates_generation_without_capture_coordinator() {
        let (_directory, project) = project();
        let recordings = FinalizingRecordings::default();
        let token = recordings.start_finalizing(project.clone()).unwrap();
        let preparing = token.preparing();
        let clone = preparing.clone();
        let completed = completed_without_receipt(project.display_path());
        let called = std::cell::Cell::new(false);
        assert!(
            preparing
                .claim_with(&completed, |actual, generation| {
                    called.set(true);
                    assert_eq!(actual.project_path, project.display_path());
                    assert_eq!(generation, 1);
                    None
                })
                .is_none()
        );
        assert!(called.get());
        assert!(
            clone
                .claim_with(&completed, |_, _| panic!(
                    "Duplicate admission cannot claim"
                ))
                .is_none()
        );
        assert!(token.attempt.result.borrow().is_none());
        token.finish(Ok(()));
    }

    #[test]
    fn lazy_open_and_recovery_origin_never_allocate_or_invoke_claim() {
        let (_directory, project) = project();
        for (origin, preparing_requested) in [
            (FinalizationOrigin::Recording, false),
            (FinalizationOrigin::Recovery, true),
        ] {
            let recordings = FinalizingRecordings::default();
            let token = recordings
                .start_with_origin(project.clone(), origin, preparing_requested)
                .unwrap();
            assert!(
                token
                    .preparing()
                    .claim_with(
                        &completed_without_receipt(project.display_path()),
                        |_, _| panic!("Ineligible finalization cannot claim")
                    )
                    .is_none()
            );
            assert_eq!(
                recordings
                    .recordings
                    .lock()
                    .unwrap()
                    .last_preparing_generation,
                0
            );
            if origin == FinalizationOrigin::Recovery {
                assert!(recordings.preparing_for_project(&project).is_none());
            }
            token.finish(Ok(()));
        }
    }

    #[test]
    fn duplicate_finalization_keeps_the_original_attempt_generation() {
        let (_directory, project) = project();
        let recordings = FinalizingRecordings::default();
        let first = recordings.start_finalizing(project.clone()).unwrap();
        assert!(recordings.start_finalizing(project.clone()).is_err());
        let existing = recordings
            .request(project.clone(), false, FinalizationOrigin::Recording, false)
            .unwrap();
        assert!(matches!(existing, crate::FinalizationRequest::Existing(_)));
        assert_eq!(first.attempt.preparing_generation, Some(1));
        assert_eq!(
            recordings
                .recordings
                .lock()
                .unwrap()
                .last_preparing_generation,
            1
        );
        assert!(
            first
                .preparing()
                .same_attempt(&recordings.preparing_for_project(&project).unwrap())
        );
        first.finish(Err("retained retry".into()));
        let next = recordings.start_finalizing(project).unwrap();
        assert_eq!(next.attempt.preparing_generation, Some(2));
        next.finish(Ok(()));
    }

    #[tokio::test]
    async fn generation_exhaustion_declines_preview_and_preserves_finalization() {
        let (_directory, project) = project();
        let recordings = FinalizingRecordings::default();
        recordings
            .recordings
            .lock()
            .unwrap()
            .last_preparing_generation = u64::MAX - 1;
        let last = recordings.start_finalizing(project.clone()).unwrap();
        assert_eq!(last.attempt.preparing_generation, Some(u64::MAX));
        last.finish(Err("retained retry".into()));
        let exhausted = recordings.start_finalizing(project.clone()).unwrap();
        assert_eq!(exhausted.attempt.preparing_generation, None);
        assert_eq!(
            recordings
                .recordings
                .lock()
                .unwrap()
                .last_preparing_generation,
            u64::MAX
        );
        let preparing = exhausted.preparing();
        assert!(
            preparing
                .claim_with(
                    &completed_without_receipt(project.display_path()),
                    |_, _| { panic!("An exhausted sequence cannot claim") }
                )
                .is_none()
        );
        assert!(wait_for_preparing(&preparing).await.is_none());
        assert!(has_pending_finalizations(
            &recordings.recordings.lock().unwrap()
        ));
        let result = exhausted.attempt.result.subscribe();
        exhausted.finish(Ok(()));
        assert_eq!(await_finalization_result(result).await, Ok(()));
        assert!(!has_pending_finalizations(
            &recordings.recordings.lock().unwrap()
        ));
    }

    #[test]
    fn a_different_stopped_project_never_invokes_claim() {
        let (_directory, project) = project();
        let other = tempfile::tempdir().unwrap();
        let recordings = FinalizingRecordings::default();
        let token = recordings.start_finalizing(project).unwrap();
        assert!(
            token
                .preparing()
                .claim_with(&completed_without_receipt(other.path()), |_, _| panic!(
                    "Wrong project cannot claim"
                ))
                .is_none()
        );
        token.finish(Ok(()));
    }

    #[test]
    fn canonical_alias_declines_without_rewriting_the_stopped_path() {
        let directory = tempfile::tempdir().unwrap();
        std::fs::create_dir(directory.path().join("alias")).unwrap();
        std::fs::create_dir(directory.path().join("project")).unwrap();
        let display = directory.path().join("alias/../project");
        let project =
            FinalizationProject::capture(display.clone(), FinalizationAccess::Write).unwrap();
        assert_ne!(project.display_path(), project.work_path());
        let recordings = FinalizingRecordings::default();
        let token = recordings.start_finalizing(project).unwrap();
        let completed = completed_without_receipt(&display);
        assert!(
            token
                .preparing()
                .claim_with(&completed, |_, _| panic!(
                    "Alias must not rebind a clean receipt"
                ))
                .is_none()
        );
        assert_eq!(completed.project_path, display);
        token.finish(Ok(()));
    }

    #[test]
    fn replaced_directory_declines_before_claim() {
        let directory = tempfile::tempdir().unwrap();
        let original = directory.path().join("project");
        let moved = directory.path().join("moved");
        std::fs::create_dir(&original).unwrap();
        let project = FinalizationProject::capture(
            original.canonicalize().unwrap(),
            FinalizationAccess::Write,
        )
        .unwrap();
        let recordings = FinalizingRecordings::default();
        let token = recordings.start_finalizing(project.clone()).unwrap();
        std::fs::rename(&original, &moved).unwrap();
        std::fs::create_dir(&original).unwrap();
        assert!(
            token
                .preparing()
                .claim_with(
                    &completed_without_receipt(project.display_path()),
                    |_, _| panic!("Replaced directory cannot claim")
                )
                .is_none()
        );
        assert!(token.attempt.result.borrow().is_none());
        token.finish(Err("directory replaced".into()));
    }

    #[tokio::test]
    async fn missing_fragments_keep_the_existing_error_and_do_not_claim() {
        let (_directory, project) = project();
        let sentinel = project.work_path().join("retained-original.bin");
        std::fs::write(&sentinel, b"retain original bytes").unwrap();
        let completed = completed_without_receipt(project.display_path());
        let recordings = FinalizingRecordings::default();
        let token = recordings.start_finalizing(project.clone()).unwrap();
        let preparing = token.preparing();
        let ordinary = crate::recording::remux_fragmented_recording_with_trigger(
            project.work_path(),
            project.display_path(),
            "recording_stop",
            None,
        );
        let candidate = crate::recording::remux_fragmented_recording_with_preparing(
            project.work_path(),
            project.display_path(),
            "recording_stop",
            None,
            Some((&preparing, &completed)),
        );
        assert_eq!(candidate, ordinary);
        assert_eq!(
            candidate.as_ref().unwrap_err(),
            "Could not find fragments to remux"
        );
        assert!(matches!(
            *token.attempt.preparing.borrow(),
            PreparingFinalizationState::Waiting
        ));
        assert_eq!(std::fs::read(sentinel).unwrap(), b"retain original bytes");
        assert!(
            !project
                .work_path()
                .join(crate::recording::FRAGMENTED_EXPORT_FFMPEG_MARKER)
                .exists()
        );
        token.finish(candidate);
        assert!(wait_for_preparing(&preparing).await.is_none());
    }
}
