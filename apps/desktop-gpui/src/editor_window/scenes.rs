//! Creating 3D shots.
//!
//! There is no setup wizard: a shot is made the way a zoom is made, by
//! pointing at the track. The empty lane offers the two openings ("Auto scene"
//! and "+ Add shot"), a lane that already has shots offers the hover ghost and
//! the drag, and every one of them lands here.
//!
//! The placement itself is [`crate::editor_panels::place_camera3d_shot`], a
//! pure function with its own tests: the old wizard's `scene_range` returned
//! `None` whenever the playhead sat inside an existing shot, and the confirm
//! button then returned silently, which is why a second scene could never be
//! added.

use super::*;
use crate::editor_panels::{
    AUTO_CAMERA3D_MAX_SHOTS, CAMERA3D_DEFAULT_SHOT_DURATION, auto_camera3d_layout,
    max_auto_camera3d_shots, new_camera3d_shot, place_camera3d_shot,
};
use cap_project::Camera3DSegment;

/// What `Auto scene` builds when nobody has said how many shots they want.
pub(crate) const CAMERA3D_AUTO_SHOTS: usize = 3;

/// What the editor says when the track has no room left.
pub(crate) const CAMERA3D_NO_ROOM: &str = "No room for another 3D shot";

impl EditorWindow {
    /// Every shot's box, which is what the placement helper reasons over.
    pub(crate) fn camera3d_shot_ranges(&self) -> Vec<(f64, f64)> {
        self.project
            .timeline
            .as_ref()
            .map(|timeline| {
                timeline
                    .camera3d_segments
                    .iter()
                    .map(|segment| (segment.start, segment.end))
                    .collect()
            })
            .unwrap_or_default()
    }

    /// `camera3DClipCuts()`: every clip boundary in output time. A generated
    /// sequence snaps its cuts onto these, which is what makes it look
    /// authored rather than sliced by a timer.
    pub(crate) fn camera3d_clip_cuts(&self) -> Vec<f64> {
        self.project
            .timeline
            .as_ref()
            .map(|timeline| {
                let offsets = crate::editor_timeline::clip_timeline_offsets(timeline);
                timeline
                    .segments
                    .iter()
                    .zip(offsets)
                    .flat_map(|(segment, offset)| [offset, offset + segment.duration()])
                    .collect()
            })
            .unwrap_or_default()
    }

    /// `+ Add shot`: one shot at `time`, or the nearest free gap to it.
    pub(crate) fn add_camera3d_shot_at(
        &mut self,
        time: f64,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if !edits::ensure_timeline(&mut self.project, &self.clip_display_durations) {
            return;
        }
        let Some((start, end)) = place_camera3d_shot(
            &self.camera3d_shot_ranges(),
            time,
            CAMERA3D_DEFAULT_SHOT_DURATION,
            self.total_duration(),
        ) else {
            self.show_notice(CAMERA3D_NO_ROOM, window, cx);
            return;
        };
        self.insert_camera3d_shots(
            vec![new_camera3d_shot(start, end)],
            "add-3d-shot",
            window,
            cx,
        );
    }

    /// The empty lane's `Auto scene` chip: open the count picker rather than
    /// guessing. Nothing is written until a count is chosen.
    pub(crate) fn open_camera3d_picker(&mut self, cx: &mut Context<Self>) {
        self.camera3d_picker = true;
        self.camera3d_count_hover = None;
        cx.notify();
    }

    pub(crate) fn close_camera3d_picker(&mut self, cx: &mut Context<Self>) {
        if self.camera3d_picker || self.camera3d_count_hover.is_some() {
            self.camera3d_picker = false;
            self.camera3d_count_hover = None;
            cx.notify();
        }
    }

    /// The pill under the pointer, in the lane's picker or the panel's Auto
    /// scene row. The lane draws the layout it would commit as ghosts.
    pub(crate) fn hover_camera3d_count(&mut self, count: Option<usize>, cx: &mut Context<Self>) {
        if self.camera3d_count_hover != count {
            self.camera3d_count_hover = count;
            cx.notify();
        }
    }

    /// The shots a hovered pill would lay down, for the lane's ghosts.
    pub(crate) fn camera3d_auto_preview(&self) -> Vec<(f64, f64)> {
        let Some(count) = self.camera3d_count_hover else {
            return Vec::new();
        };
        let cuts = self.camera3d_clip_cuts();
        auto_camera3d_layout(count, 0., self.total_duration(), &cuts)
            .into_iter()
            .map(|shot| (shot.start, shot.end))
            .collect()
    }

    /// `Auto scene` at a chosen count: the whole track re-laid from the shot
    /// pool, cut on the clip boundaries, as one undo step.
    ///
    /// It replaces every shot rather than adding to them, which is what makes
    /// the count in the panel's row a thing you can change your mind about.
    pub(crate) fn apply_auto_camera3d_scene(
        &mut self,
        count: usize,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if !edits::ensure_timeline(&mut self.project, &self.clip_display_durations) {
            return;
        }
        let count = count.clamp(1, AUTO_CAMERA3D_MAX_SHOTS);
        let total = self.total_duration();
        let cuts = self.camera3d_clip_cuts();
        let generated = auto_camera3d_layout(count, 0., total, &cuts);
        if generated.is_empty() {
            self.show_notice(CAMERA3D_NO_ROOM, window, cx);
            return;
        }
        self.camera3d_picker = false;
        self.camera3d_count_hover = None;
        if !self.edit(
            |timeline| {
                timeline.camera3d_segments = generated;
                true
            },
            window,
            cx,
        ) {
            return;
        }
        self.tracks.three_d = true;
        self.audio_picker = None;
        self.sidebar.editing_end_pose = false;
        self.set_selection(Some(Selection::single(TrackKind::ThreeD, 0)), cx);
        self.rebuild_timeline();
        self.seek_camera3d_pose(0, false, cx);
        self.view.preview_time = None;
        self.note_edit("auto-3d-scene", Some(TrackKind::ThreeD));
    }

    /// The shared tail of both: insert, show the lane, select the first shot
    /// and park the playhead on it so the panel opens on what was just made.
    fn insert_camera3d_shots(
        &mut self,
        shots: Vec<Camera3DSegment>,
        reason: &'static str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(start) = shots.first().map(|shot| shot.start) else {
            return;
        };
        if !self.edit(
            |timeline| {
                timeline.camera3d_segments.extend(shots);
                timeline
                    .camera3d_segments
                    .sort_by(|a, b| a.start.total_cmp(&b.start));
                true
            },
            window,
            cx,
        ) {
            return;
        }
        let index = self
            .project
            .timeline
            .as_ref()
            .and_then(|timeline| {
                timeline
                    .camera3d_segments
                    .iter()
                    .position(|segment| segment.start == start)
            })
            .unwrap_or(0);
        self.tracks.three_d = true;
        self.audio_picker = None;
        self.sidebar.editing_end_pose = false;
        self.set_selection(Some(Selection::single(TrackKind::ThreeD, index)), cx);
        self.rebuild_timeline();
        self.seek_camera3d_pose(index, false, cx);
        self.view.preview_time = None;
        self.note_edit(reason, Some(TrackKind::ThreeD));
    }

    /// `CAP_GPUI_AUTO_CAMERA3D=add[:<time>]|auto`, through the same actions the
    /// lane's own chips run, so a probe can photograph a freshly made shot.
    pub(crate) fn auto_camera3d(
        &mut self,
        spec: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let (action, argument) = match spec.split_once(':') {
            Some((action, argument)) => (action, Some(argument)),
            None => (spec, None),
        };
        match action.trim() {
            // `picker[:<count>]`: open the count picker, and optionally park
            // the hover on one pill so its preview ghosts are drawn.
            "picker" => {
                self.tracks.three_d = true;
                self.set_selection(None, cx);
                self.open_camera3d_picker(cx);
                let hover = argument.and_then(|value| value.trim().parse::<usize>().ok());
                if let Some(count) = hover {
                    self.hover_camera3d_count(Some(count), cx);
                }
                self.rebuild_timeline();
                tracing::info!(?hover, "auto 3d picker");
            }
            "auto" | "scene" => {
                let count = argument
                    .and_then(|value| value.trim().parse::<usize>().ok())
                    .unwrap_or(CAMERA3D_AUTO_SHOTS)
                    .min(max_auto_camera3d_shots(self.total_duration()).max(1));
                self.apply_auto_camera3d_scene(count, window, cx);
                tracing::info!(count, "auto 3d scene");
            }
            "add" | "shot" | "" => {
                let time = argument
                    .and_then(|value| value.trim().parse::<f64>().ok())
                    .unwrap_or(self.playhead);
                self.add_camera3d_shot_at(time, window, cx);
                tracing::info!(time, "auto 3d shot");
            }
            other => tracing::warn!(action = other, "unknown 3d action"),
        }
    }
}

#[cfg(test)]
mod tests {
    use crate::editor_panels::{
        AUTO_CAMERA3D_MAX_SHOTS, CAMERA3D_DEFAULT_SHOT_DURATION, CAMERA3D_SCENES,
        auto_camera3d_layout, auto_camera3d_shots, camera3d_shot_label, match_camera3d_look,
        max_auto_camera3d_shots, new_camera3d_shot, place_camera3d_shot,
    };

    /// The bug this rebuild exists to fix: with one shot under the playhead,
    /// the wizard's `scene_range` returned `None` and nothing was ever added.
    #[test]
    fn a_second_shot_lands_even_with_the_playhead_inside_the_first() {
        let existing = [(0., 6.)];
        assert_eq!(
            place_camera3d_shot(&existing, 2., CAMERA3D_DEFAULT_SHOT_DURATION, 30.),
            Some((6., 10.))
        );
    }

    #[test]
    fn a_new_shot_is_a_complete_look() {
        let shot = new_camera3d_shot(6., 10.);
        assert_eq!(camera3d_shot_label(&shot), "Glide across");
        assert_eq!(
            match_camera3d_look(&shot).map(|look| look.id),
            Some("glide-across")
        );
        // The template's own defocus came with it, and no transitions.
        assert_eq!(shot.transition_in, 0.);
        assert_eq!(shot.transition_out, 0.);
    }

    #[test]
    fn the_auto_scene_fills_the_recording_and_cuts_on_the_clips() {
        let shots = auto_camera3d_layout(3, 0., 40., &[11.5]);
        assert_eq!(shots.len(), 3);
        assert_eq!(shots[0].start, 0.);
        assert_eq!(shots[2].end, 40.);
        // The first boundary snapped onto the clip cut.
        assert!((shots[0].end - 11.5).abs() < 1e-9);
        for pair in shots.windows(2) {
            assert!((pair[1].start - pair[0].end).abs() < 1e-9);
        }
    }

    #[test]
    fn the_shot_count_decides_the_scene() {
        // One shot is the opening move over the whole recording.
        let one = auto_camera3d_layout(1, 0., 40., &[]);
        assert_eq!(one.len(), 1);
        assert_eq!((one[0].start, one[0].end), (0., 40.));
        assert_eq!(
            match_camera3d_look(&one[0]).map(|look| look.id),
            Some("glide-across")
        );

        // Everything above it is the first N of the pool, in equal shares.
        for count in 2..=AUTO_CAMERA3D_MAX_SHOTS {
            let shots = auto_camera3d_layout(count, 0., 60., &[]);
            assert_eq!(shots.len(), count, "asked for {count}");
            let share = 60. / count as f64;
            for (index, shot) in shots.iter().enumerate() {
                assert!(
                    (shot.start - index as f64 * share).abs() < 1e-6,
                    "{count} shots: shot {index} started at {}",
                    shot.start
                );
            }
            assert!((shots[count - 1].end - 60.).abs() < 1e-9);
        }

        // The pool is the three scenes' nine shots, in scene order.
        let pool = auto_camera3d_shots(9);
        let authored: Vec<_> = CAMERA3D_SCENES
            .iter()
            .flat_map(|scene| scene.shots.iter())
            .collect();
        assert_eq!(pool.len(), authored.len());
        for (mine, theirs) in pool.iter().zip(authored) {
            assert_eq!(mine.weight, 1.);
            assert_eq!(mine.from.zoom, theirs.from.zoom);
            assert_eq!(mine.to.tilt_x, theirs.to.tilt_x);
        }

        // A short recording cannot hold six one-second shots.
        assert_eq!(max_auto_camera3d_shots(3.5), 3);
        assert_eq!(max_auto_camera3d_shots(41.6), AUTO_CAMERA3D_MAX_SHOTS);
        assert_eq!(max_auto_camera3d_shots(0.5), 0);
        // And asking for more than fits truncates rather than crowding.
        assert_eq!(auto_camera3d_layout(6, 0., 3.5, &[]).len(), 3);
    }

    #[test]
    fn a_shot_count_of_zero_writes_nothing() {
        assert!(auto_camera3d_layout(0, 0., 40., &[]).is_empty());
        assert!(auto_camera3d_layout(3, 4., 4., &[]).is_empty());
    }
}
