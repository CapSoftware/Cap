use cap_project::{SceneMode, SceneSegment};

pub const MIN_GAP_FOR_TRANSITION: f64 = 0.5;

fn same_mode(a: &SceneMode, b: &SceneMode) -> bool {
    std::mem::discriminant(a) == std::mem::discriminant(b)
}

/// Modes where the screen and camera share the frame side-by-side (the
/// compositor morphs both layers toward per-pane target rects).
fn is_split_mode(mode: &SceneMode) -> bool {
    matches!(mode, SceneMode::SplitScreen | SceneMode::Floating)
}

#[derive(Debug, Clone, Copy)]
pub struct SceneSegmentsCursor<'a> {
    time: f64,
    segment: Option<&'a SceneSegment>,
    prev_segment: Option<&'a SceneSegment>,
    segments: &'a [SceneSegment],
}

impl<'a> SceneSegmentsCursor<'a> {
    pub fn new(time: f64, segments: &'a [SceneSegment]) -> Self {
        match segments
            .iter()
            .position(|s| time >= s.start && time < s.end)
        {
            Some(segment_index) => SceneSegmentsCursor {
                time,
                segment: Some(&segments[segment_index]),
                prev_segment: if segment_index > 0 {
                    Some(&segments[segment_index - 1])
                } else {
                    None
                },
                segments,
            },
            None => {
                let prev = segments
                    .iter()
                    .enumerate()
                    .rev()
                    .find(|(_, s)| s.end <= time);
                SceneSegmentsCursor {
                    time,
                    segment: None,
                    prev_segment: prev.map(|(_, s)| s),
                    segments,
                }
            }
        }
    }

    pub fn next_segment(&self) -> Option<&'a SceneSegment> {
        let current_time = self.time;
        self.segments.iter().find(|s| s.start > current_time)
    }
}

#[derive(Debug, Clone, Copy)]
pub struct InterpolatedScene {
    pub camera_opacity: f64,
    pub screen_opacity: f64,
    pub camera_scale: f64,
    pub scene_mode: SceneMode,
    pub transition_progress: f64,
    pub from_mode: SceneMode,
    pub to_mode: SceneMode,
    pub screen_blur: f64,
    pub camera_only_zoom: f64,
    pub camera_only_blur: f64,
    /// 0.0 = no split layout, 1.0 = fully side-by-side. Ramps with
    /// `transition_progress` when entering/leaving [`SceneMode::SplitScreen`]
    /// or [`SceneMode::Floating`] so the compositor morphs the screen+camera
    /// rects toward their panes.
    pub split_factor: f64,
    /// Share of the split that is the floating-cards variant
    /// ([`SceneMode::Floating`]). Always <= `split_factor`; the compositor
    /// blends the pane targets from full-bleed halves toward padded cards by
    /// `floating_factor / split_factor` and keeps rounding/shadow chrome alive
    /// in proportion to it.
    pub floating_factor: f64,
}

impl InterpolatedScene {
    fn from_single_mode(scene_mode: SceneMode) -> Self {
        let (camera_opacity, screen_opacity, camera_scale) = Self::get_scene_values(&scene_mode);

        InterpolatedScene {
            camera_opacity,
            screen_opacity,
            camera_scale,
            scene_mode,
            transition_progress: 1.0,
            from_mode: scene_mode,
            to_mode: scene_mode,
            screen_blur: 0.0,
            camera_only_zoom: 1.0,
            camera_only_blur: 0.0,
            split_factor: if is_split_mode(&scene_mode) { 1.0 } else { 0.0 },
            floating_factor: if matches!(scene_mode, SceneMode::Floating) {
                1.0
            } else {
                0.0
            },
        }
    }

    pub fn new(cursor: SceneSegmentsCursor) -> Self {
        let ease_in_out = bezier_easing::bezier_easing(0.42, 0.0, 0.58, 1.0).unwrap();

        let (current_mode, next_mode, transition_progress) = if let Some(segment) = cursor.segment {
            let transition_in = segment.transition_in.max(0.0);
            let transition_out = segment.transition_out.max(0.0);
            let transition_start = segment.start - transition_in;
            let transition_end = segment.end - transition_out;

            if cursor.time < segment.start && cursor.time >= transition_start {
                // Check if we should skip transition for small gaps
                let prev_mode = if let Some(prev_seg) = cursor.prev_segment {
                    let gap = segment.start - prev_seg.end;
                    if gap < MIN_GAP_FOR_TRANSITION && same_mode(&prev_seg.mode, &segment.mode) {
                        // Small gap between same modes, no transition needed
                        return InterpolatedScene::from_single_mode(segment.mode);
                    } else if gap > 0.01 {
                        SceneMode::Default
                    } else {
                        prev_seg.mode
                    }
                } else {
                    SceneMode::Default
                };
                let progress = (cursor.time - transition_start) / transition_in.max(1e-4);
                (prev_mode, segment.mode, ease_in_out(progress as f32) as f64)
            } else if cursor.time >= transition_end && cursor.time < segment.end {
                if let Some(next_seg) = cursor.next_segment() {
                    let gap = next_seg.start - segment.end;

                    // For small gaps between same-mode segments, don't transition
                    if gap < MIN_GAP_FOR_TRANSITION && same_mode(&segment.mode, &next_seg.mode) {
                        // Keep the current mode without transitioning
                        (segment.mode, segment.mode, 1.0)
                    } else if gap > 0.01 {
                        // There's a significant gap, so transition to default scene
                        let progress =
                            ((cursor.time - transition_end) / transition_out.max(1e-4)).min(1.0);
                        (
                            segment.mode,
                            SceneMode::Default,
                            ease_in_out(progress as f32) as f64,
                        )
                    } else {
                        // No gap, segments are back-to-back, transition directly if modes differ
                        let progress =
                            ((cursor.time - transition_end) / transition_out.max(1e-4)).min(1.0);
                        (
                            segment.mode,
                            next_seg.mode,
                            ease_in_out(progress as f32) as f64,
                        )
                    }
                } else {
                    // No next segment, transition to default
                    let progress =
                        ((cursor.time - transition_end) / transition_out.max(1e-4)).min(1.0);
                    (
                        segment.mode,
                        SceneMode::Default,
                        ease_in_out(progress as f32) as f64,
                    )
                }
            } else {
                (segment.mode, segment.mode, 1.0)
            }
        } else if let Some(next_segment) = cursor.next_segment() {
            let transition_in = next_segment.transition_in.max(0.0);
            let transition_start = next_segment.start - transition_in;

            if let Some(prev_seg) = cursor.prev_segment {
                let gap = next_segment.start - prev_seg.end;

                // For small gaps between same-mode segments, stay in that mode
                if gap < MIN_GAP_FOR_TRANSITION && same_mode(&prev_seg.mode, &next_segment.mode) {
                    (prev_seg.mode, prev_seg.mode, 1.0)
                } else if cursor.time >= transition_start {
                    // Start transitioning into the next segment
                    let prev_mode = if gap > 0.01 {
                        SceneMode::Default
                    } else {
                        prev_seg.mode
                    };
                    let progress = (cursor.time - transition_start) / transition_in.max(1e-4);
                    (
                        prev_mode,
                        next_segment.mode,
                        ease_in_out(progress as f32) as f64,
                    )
                } else {
                    // We're in a gap that requires transition - should be at default
                    (SceneMode::Default, SceneMode::Default, 1.0)
                }
            } else if cursor.time >= transition_start {
                // No previous segment, transitioning into the first segment
                let progress = (cursor.time - transition_start) / transition_in.max(1e-4);
                (
                    SceneMode::Default,
                    next_segment.mode,
                    ease_in_out(progress as f32) as f64,
                )
            } else {
                (SceneMode::Default, SceneMode::Default, 1.0)
            }
        } else {
            // No next segment (at the end of timeline)
            // The transition should have already completed inside the last segment
            (SceneMode::Default, SceneMode::Default, 1.0)
        };

        let (start_camera_opacity, start_screen_opacity, start_camera_scale) =
            Self::get_scene_values(&current_mode);
        let (end_camera_opacity, end_screen_opacity, end_camera_scale) =
            Self::get_scene_values(&next_mode);

        let camera_opacity = Self::lerp(
            start_camera_opacity,
            end_camera_opacity,
            transition_progress,
        );
        let screen_opacity = Self::lerp(
            start_screen_opacity,
            end_screen_opacity,
            transition_progress,
        );
        let camera_scale = Self::lerp(start_camera_scale, end_camera_scale, transition_progress);

        let screen_blur = if matches!(current_mode, SceneMode::CameraOnly)
            || matches!(next_mode, SceneMode::CameraOnly)
        {
            if matches!(current_mode, SceneMode::CameraOnly)
                && !matches!(next_mode, SceneMode::CameraOnly)
            {
                Self::lerp(1.0, 0.0, transition_progress)
            } else if !matches!(current_mode, SceneMode::CameraOnly)
                && matches!(next_mode, SceneMode::CameraOnly)
            {
                transition_progress
            } else {
                0.0
            }
        } else {
            0.0
        };

        let camera_only_zoom = if matches!(next_mode, SceneMode::CameraOnly)
            && !matches!(current_mode, SceneMode::CameraOnly)
        {
            Self::lerp(1.1, 1.0, transition_progress)
        } else if matches!(current_mode, SceneMode::CameraOnly)
            && !matches!(next_mode, SceneMode::CameraOnly)
        {
            Self::lerp(1.0, 1.1, transition_progress)
        } else {
            1.0
        };

        let camera_only_blur = if matches!(next_mode, SceneMode::CameraOnly)
            && !matches!(current_mode, SceneMode::CameraOnly)
        {
            Self::lerp(1.0, 0.0, transition_progress)
        } else if matches!(current_mode, SceneMode::CameraOnly)
            && !matches!(next_mode, SceneMode::CameraOnly)
        {
            transition_progress
        } else {
            0.0
        };

        let from_split = is_split_mode(&current_mode);
        let to_split = is_split_mode(&next_mode);
        let split_factor = match (from_split, to_split) {
            (true, true) => 1.0,
            (false, true) => transition_progress,
            (true, false) => 1.0 - transition_progress,
            (false, false) => 0.0,
        };

        let from_floating = matches!(current_mode, SceneMode::Floating);
        let to_floating = matches!(next_mode, SceneMode::Floating);
        let floating_factor = match (from_floating, to_floating) {
            (true, true) => 1.0,
            (false, true) => transition_progress,
            (true, false) => 1.0 - transition_progress,
            (false, false) => 0.0,
        };

        InterpolatedScene {
            camera_opacity,
            screen_opacity,
            camera_scale,
            scene_mode: if transition_progress > 0.5 {
                next_mode
            } else {
                current_mode
            },
            transition_progress,
            from_mode: current_mode,
            to_mode: next_mode,
            screen_blur,
            camera_only_zoom,
            camera_only_blur,
            split_factor,
            floating_factor,
        }
    }

    fn get_scene_values(mode: &SceneMode) -> (f64, f64, f64) {
        match mode {
            SceneMode::Default => (1.0, 1.0, 1.0),
            SceneMode::CameraOnly => (1.0, 1.0, 1.0),
            SceneMode::HideCamera => (0.0, 1.0, 1.0),
            // Both panes fully visible; the split geometry (50/50 halves or
            // floating cards) is applied in the compositor, driven by
            // `split_factor` + `floating_factor`.
            SceneMode::SplitScreen | SceneMode::Floating => (1.0, 1.0, 1.0),
        }
    }

    fn lerp(start: f64, end: f64, t: f64) -> f64 {
        start + (end - start) * t
    }

    pub fn should_render_camera(&self) -> bool {
        self.camera_opacity > 0.01
    }

    pub fn should_render_screen(&self) -> bool {
        self.screen_opacity > 0.01 || self.screen_blur > 0.01
    }

    pub fn is_split(&self) -> bool {
        self.split_factor > 0.001
    }

    pub fn is_transitioning_camera_only(&self) -> bool {
        matches!(self.from_mode, SceneMode::CameraOnly)
            || matches!(self.to_mode, SceneMode::CameraOnly)
    }

    pub fn camera_only_transition_opacity(&self) -> f64 {
        if matches!(self.from_mode, SceneMode::CameraOnly)
            && !matches!(self.to_mode, SceneMode::CameraOnly)
        {
            1.0 - self.transition_progress
        } else if !matches!(self.from_mode, SceneMode::CameraOnly)
            && matches!(self.to_mode, SceneMode::CameraOnly)
        {
            self.transition_progress
        } else if matches!(self.from_mode, SceneMode::CameraOnly)
            && matches!(self.to_mode, SceneMode::CameraOnly)
        {
            1.0
        } else {
            0.0
        }
    }

    pub fn regular_camera_transition_opacity(&self) -> f64 {
        if matches!(self.to_mode, SceneMode::CameraOnly)
            && !matches!(self.from_mode, SceneMode::CameraOnly)
        {
            let fast_fade = (1.0 - self.transition_progress * 1.5).max(0.0);
            fast_fade * self.camera_opacity
        } else if matches!(self.from_mode, SceneMode::CameraOnly)
            && !matches!(self.to_mode, SceneMode::CameraOnly)
        {
            let fast_fade = (self.transition_progress * 1.5).min(1.0);
            fast_fade * self.camera_opacity
        } else if matches!(self.from_mode, SceneMode::CameraOnly)
            && matches!(self.to_mode, SceneMode::CameraOnly)
        {
            0.0
        } else {
            self.camera_opacity
        }
    }
}
