//! "Hide when silent": the camera steps aside while nobody is talking.
//!
//! Speech detection runs once per opened project and lands as ordinary
//! `HideCamera` scene segments, so the result shows on the Scene track and can
//! be trimmed or deleted like any other scene.

use super::*;
use cap_rendering::{ClipSpeech, regenerate_silence_scenes};

impl EditorWindow {
    fn cached_clip_speech(&self) -> Option<Arc<Vec<Option<ClipSpeech>>>> {
        self.clip_speech
            .clone()
            .filter(|speech| speech.len() == self.clip_display_durations.len())
    }

    pub(crate) fn toggle_camera_silence(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.analyzing_speech {
            return;
        }
        if self.project.camera_silence_delay.is_some() {
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

        self.analyzing_speech = true;
        cx.notify();
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
                this.enable_camera_silence(&speech, window, cx);
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
        let edited = self.edit_timeline_project(
            |project| {
                project.camera_silence_delay = Some(delay);
                true
            },
            window,
            cx,
        );
        if edited {
            self.note_edit("camera-silence-delay", Some(TrackKind::Scene));
        }
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
