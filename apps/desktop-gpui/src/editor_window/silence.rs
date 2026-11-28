use super::*;
use cap_rendering::{ClipSpeech, regenerate_silence_scenes};

/// What to do with the speech analysis once it lands. Cleared when the user
/// backs out, because the running analysis cannot be stopped.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) enum SpeechRequest {
    Enable,
    Delay(f32),
}

impl EditorWindow {
    fn cached_clip_speech(&self) -> Option<Arc<Vec<Option<ClipSpeech>>>> {
        self.clip_speech.clone().filter(|speech| {
            speech.len() == self.clip_display_durations.len() && speech.iter().any(Option::is_some)
        })
    }

    pub(crate) fn pending_silence_delay(&self) -> Option<f32> {
        match self.speech_request {
            Some(SpeechRequest::Delay(delay)) => Some(delay),
            _ => None,
        }
    }

    pub(crate) fn enabling_camera_silence(&self) -> bool {
        self.speech_request == Some(SpeechRequest::Enable)
    }

    pub(crate) fn toggle_camera_silence(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.enabling_camera_silence() {
            self.speech_request = None;
            cx.notify();
            return;
        }
        if self.project.camera_silence_delay.is_some() {
            self.speech_request = None;
            let cleared = self.edit_timeline_project(
                |project| {
                    project.camera_silence_delay = None;
                    if let Some(timeline) = project.timeline.as_mut() {
                        timeline.scene_segments.retain(|scene| !scene.from_silence);
                    }
                    true
                },
                window,
                cx,
            );
            if cleared {
                self.note_edit("camera-silence-off", Some(TrackKind::Scene));
            }
            return;
        }
        if let Some(speech) = self.cached_clip_speech() {
            self.enable_camera_silence(&speech, window, cx);
            return;
        }
        self.speech_request = Some(SpeechRequest::Enable);
        self.analyze_speech(window, cx);
    }

    fn analyze_speech(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        cx.notify();
        if self.analyzing_speech {
            return;
        }
        self.analyzing_speech = true;
        let path = self.project_path.clone();
        cx.spawn_in(window, async move |this, cx| {
            let speech = cx
                .background_executor()
                .spawn(async move { analyze_project_speech(&path) })
                .await;
            this.update_in(cx, |this, window, cx| {
                this.analyzing_speech = false;
                let speech = Arc::new(speech);
                this.clip_speech = Some(Arc::clone(&speech));
                this.land_silence_resync(window, cx);
                match this.speech_request.take() {
                    Some(SpeechRequest::Enable) => this.enable_camera_silence(&speech, window, cx),
                    // Unreadable mics count as speech, which would wipe the
                    // scenes the delay was only meant to adjust.
                    Some(SpeechRequest::Delay(delay))
                        if this.project.camera_silence_delay.is_some()
                            && speech.iter().any(Option::is_some) =>
                    {
                        this.write_camera_silence(delay, &speech, window, cx);
                    }
                    _ => {}
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    fn enable_camera_silence(
        &mut self,
        speech: &[Option<ClipSpeech>],
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        edits::ensure_timeline(&mut self.project, &self.clip_display_durations);
        let delay = cap_project::ProjectConfiguration::CAMERA_SILENCE_DELAY_DEFAULT;
        let mut preview = self.project.clone();
        if regenerate_silence_scenes(&mut preview, speech, f64::from(delay)) == 0 {
            self.show_notice(tr::editor::tabs::camera::no_silence_found(), window, cx);
            return;
        }
        self.write_camera_silence(delay, speech, window, cx);
        self.tracks.scene = true;
        self.note_edit("camera-silence-on", Some(TrackKind::Scene));
    }

    pub(crate) fn set_camera_silence_delay(
        &mut self,
        delay: f32,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if let Some(speech) = self.cached_clip_speech() {
            self.write_camera_silence(delay, &speech, window, cx);
            return;
        }
        self.speech_request = Some(SpeechRequest::Delay(delay));
        self.analyze_speech(window, cx);
    }

    fn write_camera_silence(
        &mut self,
        delay: f32,
        speech: &[Option<ClipSpeech>],
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.edit_timeline_project(
            |project| {
                project.camera_silence_delay = Some(delay);
                regenerate_silence_scenes(project, speech, f64::from(delay));
                true
            },
            window,
            cx,
        );
    }

    pub(super) fn trust_loaded_silence_scenes(&mut self) {
        self.silence_sync_signature = silence_timing_signature(&self.project);
    }

    /// An undo entry already holds the scenes that belong to its timeline.
    /// Entries recorded before the mics were read may not, and those keep the
    /// signature stale so the pending analysis still repairs them.
    pub(super) fn adopt_restored_silence_scenes(&mut self) {
        if self.cached_clip_speech().is_some() {
            self.trust_loaded_silence_scenes();
        }
    }

    /// Generated scenes sit at output times, so a reorder, trim, speed
    /// change, transition, hold or mic offset moves the speech out from under
    /// them and can leave the camera hidden over a spoken clip. Runs before
    /// the edit is recorded so the two are one undo step.
    pub(super) fn synchronize_silence_scenes(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> bool {
        self.catch_up_silence_scenes(false, window, cx)
    }

    /// The same catch-up for a change that rewrote every undo entry, where
    /// each entry's scenes have to follow its own timeline.
    pub(super) fn resynchronize_silence_history(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.catch_up_silence_scenes(true, window, cx);
    }

    fn catch_up_silence_scenes(
        &mut self,
        every_undo_entry: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> bool {
        if !silence_scenes_stale(&self.project, self.silence_sync_signature) {
            return false;
        }
        let Some(speech) = self.cached_clip_speech() else {
            self.analyze_speech(window, cx);
            return false;
        };
        self.regenerate_stale_silence_scenes(&speech, every_undo_entry, cx);
        true
    }

    /// Edits made while the mics were still being read were recorded with
    /// scenes from before them, so the result is written into those entries
    /// instead of becoming an undo step that changes nothing the user did.
    fn land_silence_resync(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if !silence_scenes_stale(&self.project, self.silence_sync_signature) {
            return;
        }
        let Some(speech) = self.cached_clip_speech() else {
            // Left stale, every later edit, slider ticks included, would
            // decode every mic again. The next timing change retries once.
            self.trust_loaded_silence_scenes();
            return;
        };
        self.end_timeline_gesture(window, cx);
        self.regenerate_stale_silence_scenes(&speech, true, cx);
        self.rebuild_timeline();
        self.publish_project();
        self.schedule_save(window, cx);
    }

    fn regenerate_stale_silence_scenes(
        &mut self,
        speech: &[Option<ClipSpeech>],
        every_undo_entry: bool,
        cx: &mut Context<Self>,
    ) {
        self.silence_sync_signature = follow_speech_timing(
            &mut self.project,
            every_undo_entry.then_some(&mut self.history),
            speech,
        );
        if self
            .selection
            .as_ref()
            .is_some_and(|selection| selection.track == TrackKind::Scene)
        {
            self.set_selection(None, cx);
        }
    }
}

/// Everything that decides where speech lands on the timeline. Scene edits
/// are left out on purpose: regenerating re-sorts the scene track, which
/// would renumber a scene while it is being dragged.
fn silence_timing_signature(project: &ProjectConfiguration) -> Option<u64> {
    use std::hash::{Hash, Hasher};

    let timeline = project.timeline.as_ref()?;
    let mut hasher = std::hash::DefaultHasher::new();
    hash_clip_time_mapping(timeline, &mut hasher);
    for clip in &project.clips {
        clip.index.hash(&mut hasher);
        clip.offsets.mic.to_bits().hash(&mut hasher);
    }
    Some(hasher.finish())
}

fn silence_scenes_stale(project: &ProjectConfiguration, synced: Option<u64>) -> bool {
    project.camera_silence_delay.is_some() && synced != silence_timing_signature(project)
}

fn follow_speech_timing(
    project: &mut ProjectConfiguration,
    history: Option<&mut ProjectHistory>,
    speech: &[Option<ClipSpeech>],
) -> Option<u64> {
    let regenerate = |project: &mut ProjectConfiguration| {
        if let Some(delay) = project.camera_silence_delay {
            regenerate_silence_scenes(project, speech, f64::from(delay));
        }
    };
    if let Some(history) = history {
        history.amend_all(regenerate);
    }
    regenerate(project);
    silence_timing_signature(project)
}

fn analyze_project_speech(project_path: &std::path::Path) -> Vec<Option<ClipSpeech>> {
    let Ok(meta) = RecordingMeta::load_for_project(project_path) else {
        return Vec::new();
    };
    let RecordingMetaInner::Studio(studio) = &meta.inner else {
        return Vec::new();
    };
    cap_editor::analyze_clip_speech(project_path, studio)
}

#[cfg(test)]
mod tests {
    use super::*;
    use cap_project::{SceneMode, SceneSegment, TimelineSegment};

    const CLIP_SECS: f64 = 10.0;

    fn clip_speech() -> Vec<Option<ClipSpeech>> {
        let speech = |spans: &[(f64, f64)]| {
            Some(ClipSpeech {
                spans: spans.to_vec(),
                timing_offset: 0.0,
            })
        };
        vec![speech(&[]), speech(&[(0.0, CLIP_SECS)])]
    }

    fn manual_scene(start: f64, end: f64) -> SceneSegment {
        SceneSegment {
            start,
            end,
            mode: SceneMode::CameraOnly,
            split_layout: None,
            transition_in: 0.3,
            transition_out: 0.3,
            from_silence: false,
        }
    }

    fn silent_then_spoken() -> (ProjectConfiguration, Option<u64>) {
        let clip = |recording_clip| TimelineSegment {
            recording_clip,
            timescale: 1.0,
            start: 0.0,
            end: CLIP_SECS,
            ..Default::default()
        };
        let mut timeline: TimelineConfiguration =
            serde_json::from_value(serde_json::json!({ "segments": [], "zoomSegments": [] }))
                .unwrap();
        timeline.segments = vec![clip(0), clip(1)];
        timeline.scene_segments = vec![manual_scene(15.0, 16.0)];
        let mut project = ProjectConfiguration {
            timeline: Some(timeline),
            camera_silence_delay: Some(2.0),
            ..Default::default()
        };
        let synced = follow_speech_timing(&mut project, None, &clip_speech());
        (project, synced)
    }

    fn timeline(project: &mut ProjectConfiguration) -> &mut TimelineConfiguration {
        project.timeline.as_mut().unwrap()
    }

    fn swap_clips(project: &mut ProjectConfiguration) {
        assert!(crate::editor_clips::move_clip(timeline(project), 0, 2));
    }

    fn scenes(project: &ProjectConfiguration, from_silence: bool) -> Vec<(f64, f64)> {
        project
            .timeline
            .as_ref()
            .unwrap()
            .scene_segments
            .iter()
            .filter(|scene| scene.from_silence == from_silence)
            .map(|scene| (scene.start, scene.end))
            .collect()
    }

    fn assert_hidden_only_over(project: &ProjectConfiguration, start: f64, end: f64) {
        let hidden = scenes(project, true);
        assert!(!hidden.is_empty());
        assert!(
            hidden
                .iter()
                .all(|(from, to)| *from >= start && *to <= end + 1e-9),
            "{hidden:?} leaves {start}..{end}"
        );
    }

    #[test]
    fn reordering_clips_moves_the_hidden_camera_with_the_silent_clip() {
        let (mut project, synced) = silent_then_spoken();
        assert_hidden_only_over(&project, 0.0, CLIP_SECS);
        assert!(!silence_scenes_stale(&project, synced));

        swap_clips(&mut project);
        assert!(silence_scenes_stale(&project, synced));
        let synced = follow_speech_timing(&mut project, None, &clip_speech());
        assert_hidden_only_over(&project, CLIP_SECS, CLIP_SECS * 2.0);
        assert_eq!(scenes(&project, false), vec![(15.0, 16.0)]);
        assert!(!silence_scenes_stale(&project, synced));
    }

    #[test]
    fn every_edit_that_moves_speech_makes_the_scenes_stale() {
        let (project, synced) = silent_then_spoken();
        let stale_after = |edit: &dyn Fn(&mut ProjectConfiguration)| {
            let mut project = project.clone();
            edit(&mut project);
            silence_scenes_stale(&project, synced)
        };
        assert!(stale_after(
            &|project| timeline(project).segments[0].end = 6.0
        ));
        assert!(stale_after(
            &|project| timeline(project).segments[1].start = 2.0
        ));
        assert!(stale_after(
            &|project| timeline(project).segments[0].timescale = 2.0
        ));
        assert!(stale_after(&|project| {
            timeline(project).transitions = serde_json::from_value(serde_json::json!([
                { "segmentIndex": 1, "type": "cross-fade", "duration": 1.0 }
            ]))
            .unwrap();
        }));
        assert!(stale_after(&|project| {
            timeline(project).text_segments = serde_json::from_value(serde_json::json!([
                { "start": 4.0, "end": 6.0, "layout": "fullscreen", "content": "Title" }
            ]))
            .unwrap();
        }));
        assert!(stale_after(&|project| {
            project.clips.push(cap_project::ClipConfiguration {
                index: 1,
                offsets: cap_project::ClipOffsets {
                    mic: 0.5,
                    ..Default::default()
                },
                ..Default::default()
            });
        }));
    }

    #[test]
    fn scene_edits_and_a_disabled_setting_leave_the_scenes_alone() {
        let (project, synced) = silent_then_spoken();
        let mut edited = project.clone();
        timeline(&mut edited).scene_segments[0].end += 1.0;
        timeline(&mut edited)
            .scene_segments
            .push(manual_scene(3.0, 4.0));
        assert!(!silence_scenes_stale(&edited, synced));

        let mut disabled = project.clone();
        disabled.camera_silence_delay = None;
        timeline(&mut disabled)
            .scene_segments
            .retain(|scene| !scene.from_silence);
        swap_clips(&mut disabled);
        assert!(!silence_scenes_stale(&disabled, synced));
        follow_speech_timing(&mut disabled, None, &clip_speech());
        assert!(scenes(&disabled, true).is_empty());
    }

    #[test]
    fn mic_offsets_and_speed_move_the_hidden_window() {
        let (mut project, _) = silent_then_spoken();
        timeline(&mut project).segments[0].timescale = 2.0;
        follow_speech_timing(&mut project, None, &clip_speech());
        assert_hidden_only_over(&project, 0.0, CLIP_SECS / 2.0);

        project.clips.push(cap_project::ClipConfiguration {
            index: 1,
            offsets: cap_project::ClipOffsets {
                mic: -4.0,
                ..Default::default()
            },
            ..Default::default()
        });
        follow_speech_timing(&mut project, None, &clip_speech());
        assert_hidden_only_over(&project, 0.0, CLIP_SECS / 2.0 + 4.0);
        assert!(
            scenes(&project, true)
                .iter()
                .any(|(_, end)| *end > CLIP_SECS / 2.0 + 1.0)
        );
    }

    #[test]
    fn edits_recorded_before_the_mics_were_read_are_repaired_in_place() {
        let (mut project, synced) = silent_then_spoken();
        let mut history = ProjectHistory::new(project.clone());
        swap_clips(&mut project);
        history.record(&project);
        project.camera_silence_delay = None;
        timeline(&mut project)
            .scene_segments
            .retain(|scene| !scene.from_silence);
        history.record(&project);
        project = history.undo().unwrap().clone();
        assert!(silence_scenes_stale(&project, synced));
        assert_hidden_only_over(&project, 0.0, CLIP_SECS);

        let synced = follow_speech_timing(&mut project, Some(&mut history), &clip_speech());
        assert!(!silence_scenes_stale(&project, synced));
        assert_hidden_only_over(&project, CLIP_SECS, CLIP_SECS * 2.0);

        let turned_off = history.redo().unwrap().clone();
        assert!(scenes(&turned_off, true).is_empty());
        assert!(!history.can_redo());
        let swapped = history.undo().unwrap().clone();
        assert_hidden_only_over(&swapped, CLIP_SECS, CLIP_SECS * 2.0);
        assert_eq!(scenes(&swapped, false), vec![(15.0, 16.0)]);
        let before_the_swap = history.undo().unwrap().clone();
        assert_hidden_only_over(&before_the_swap, 0.0, CLIP_SECS);
        assert!(!history.can_undo());
    }
}
