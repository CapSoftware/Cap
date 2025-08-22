use cap_project::{LayoutMode, LayoutSegment};

pub const LAYOUT_TRANSITION_DURATION: f64 = 0.3;
pub const MIN_GAP_FOR_TRANSITION: f64 = 0.5;

#[derive(Debug, Clone, Copy)]
pub struct LayoutSegmentsCursor<'a> {
    time: f64,
    segment: Option<&'a LayoutSegment>,
    prev_segment: Option<&'a LayoutSegment>,
    segments: &'a [LayoutSegment],
}

impl<'a> LayoutSegmentsCursor<'a> {
    pub fn new(time: f64, segments: &'a [LayoutSegment]) -> Self {
        match segments
            .iter()
            .position(|s| time >= s.start && time < s.end)
        {
            Some(segment_index) => LayoutSegmentsCursor {
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
                LayoutSegmentsCursor {
                    time,
                    segment: None,
                    prev_segment: prev.map(|(_, s)| s),
                    segments,
                }
            }
        }
    }

    pub fn next_segment(&self) -> Option<&'a LayoutSegment> {
        let current_time = self.time;
        self.segments.iter().find(|s| s.start > current_time)
    }
}

#[derive(Debug, Clone, Copy)]
pub struct InterpolatedLayout {
    pub camera_opacity: f64,
    pub screen_opacity: f64,
    pub camera_scale: f64,
    pub layout_mode: LayoutMode,
    pub transition_progress: f64,
    pub from_mode: LayoutMode,
    pub to_mode: LayoutMode,
    pub screen_blur: f64,
    pub camera_only_zoom: f64,
    pub camera_only_blur: f64,
}

impl InterpolatedLayout {
    fn from_single_mode(mode: LayoutMode) -> Self {
        let (camera_opacity, screen_opacity, camera_scale) = Self::get_layout_values(&mode);
        
        InterpolatedLayout {
            camera_opacity,
            screen_opacity,
            camera_scale,
            layout_mode: mode.clone(),
            transition_progress: 1.0,
            from_mode: mode.clone(),
            to_mode: mode,
            screen_blur: 0.0,
            camera_only_zoom: 1.0,
            camera_only_blur: 0.0,
        }
    }
    
    pub fn new(cursor: LayoutSegmentsCursor) -> Self {
        let ease_in_out = bezier_easing::bezier_easing(0.42, 0.0, 0.58, 1.0).unwrap();

        let (current_mode, next_mode, transition_progress) = if let Some(segment) = cursor.segment {
            let transition_start = segment.start - LAYOUT_TRANSITION_DURATION;
            let transition_end = segment.end - LAYOUT_TRANSITION_DURATION;

            if cursor.time < segment.start && cursor.time >= transition_start {
                // Check if we should skip transition for small gaps
                let prev_mode = if let Some(prev_seg) = cursor.prev_segment {
                    let gap = segment.start - prev_seg.end;
                    let same_mode = matches!(
                        (&prev_seg.mode, &segment.mode),
                        (LayoutMode::CameraOnly, LayoutMode::CameraOnly) |
                        (LayoutMode::Default, LayoutMode::Default) |
                        (LayoutMode::HideCamera, LayoutMode::HideCamera)
                    );
                    if gap < MIN_GAP_FOR_TRANSITION && same_mode {
                        // Small gap between same modes, no transition needed
                        return InterpolatedLayout::from_single_mode(segment.mode.clone());
                    } else if gap > 0.01 {
                        LayoutMode::Default
                    } else {
                        prev_seg.mode.clone()
                    }
                } else {
                    LayoutMode::Default
                };
                let progress = (cursor.time - transition_start) / LAYOUT_TRANSITION_DURATION;
                (
                    prev_mode,
                    segment.mode.clone(),
                    ease_in_out(progress as f32) as f64,
                )
            } else if cursor.time >= transition_end && cursor.time < segment.end {
                if let Some(next_seg) = cursor.next_segment() {
                    let gap = next_seg.start - segment.end;
                    
                    // For small gaps between same-mode segments, don't transition
                    let same_mode = matches!(
                        (&segment.mode, &next_seg.mode),
                        (LayoutMode::CameraOnly, LayoutMode::CameraOnly) |
                        (LayoutMode::Default, LayoutMode::Default) |
                        (LayoutMode::HideCamera, LayoutMode::HideCamera)
                    );
                    if gap < MIN_GAP_FOR_TRANSITION && same_mode {
                        // Keep the current mode without transitioning
                        (segment.mode.clone(), segment.mode.clone(), 1.0)
                    } else if gap > 0.01 {
                        // There's a significant gap, so transition to default layout
                        let progress = ((cursor.time - transition_end) / LAYOUT_TRANSITION_DURATION).min(1.0);
                        (
                            segment.mode.clone(),
                            LayoutMode::Default,
                            ease_in_out(progress as f32) as f64,
                        )
                    } else {
                        // No gap, segments are back-to-back, transition directly if modes differ
                        let progress = ((cursor.time - transition_end) / LAYOUT_TRANSITION_DURATION).min(1.0);
                        (
                            segment.mode.clone(),
                            next_seg.mode.clone(),
                            ease_in_out(progress as f32) as f64,
                        )
                    }
                } else {
                    // No next segment, transition to default
                    let progress = ((cursor.time - transition_end) / LAYOUT_TRANSITION_DURATION).min(1.0);
                    (
                        segment.mode.clone(),
                        LayoutMode::Default,
                        ease_in_out(progress as f32) as f64,
                    )
                }
            } else {
                (segment.mode.clone(), segment.mode.clone(), 1.0)
            }
        } else if let Some(next_segment) = cursor.next_segment() {
            let transition_start = next_segment.start - LAYOUT_TRANSITION_DURATION;
            
            if let Some(prev_seg) = cursor.prev_segment {
                let gap = next_segment.start - prev_seg.end;
                
                // For small gaps between same-mode segments, stay in that mode
                let same_mode = matches!(
                    (&prev_seg.mode, &next_segment.mode),
                    (LayoutMode::CameraOnly, LayoutMode::CameraOnly) |
                    (LayoutMode::Default, LayoutMode::Default) |
                    (LayoutMode::HideCamera, LayoutMode::HideCamera)
                );
                if gap < MIN_GAP_FOR_TRANSITION && same_mode {
                    (prev_seg.mode.clone(), prev_seg.mode.clone(), 1.0)
                } else if cursor.time >= transition_start {
                    // Start transitioning into the next segment
                    let prev_mode = if gap > 0.01 {
                        LayoutMode::Default
                    } else {
                        prev_seg.mode.clone()
                    };
                    let progress = (cursor.time - transition_start) / LAYOUT_TRANSITION_DURATION;
                    (
                        prev_mode,
                        next_segment.mode.clone(),
                        ease_in_out(progress as f32) as f64,
                    )
                } else {
                    // We're in a gap that requires transition - should be at default
                    (LayoutMode::Default, LayoutMode::Default, 1.0)
                }
            } else if cursor.time >= transition_start {
                // No previous segment, transitioning into the first segment
                let progress = (cursor.time - transition_start) / LAYOUT_TRANSITION_DURATION;
                (
                    LayoutMode::Default,
                    next_segment.mode.clone(),
                    ease_in_out(progress as f32) as f64,
                )
            } else {
                (LayoutMode::Default, LayoutMode::Default, 1.0)
            }
        } else {
            // No next segment (at the end of timeline)
            // The transition should have already completed inside the last segment
            (LayoutMode::Default, LayoutMode::Default, 1.0)
        };

        let (start_camera_opacity, start_screen_opacity, start_camera_scale) =
            Self::get_layout_values(&current_mode);
        let (end_camera_opacity, end_screen_opacity, end_camera_scale) =
            Self::get_layout_values(&next_mode);

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

        let screen_blur = if matches!(current_mode, LayoutMode::CameraOnly)
            || matches!(next_mode, LayoutMode::CameraOnly)
        {
            if matches!(current_mode, LayoutMode::CameraOnly)
                && !matches!(next_mode, LayoutMode::CameraOnly)
            {
                Self::lerp(1.0, 0.0, transition_progress)
            } else if !matches!(current_mode, LayoutMode::CameraOnly)
                && matches!(next_mode, LayoutMode::CameraOnly)
            {
                transition_progress
            } else {
                0.0
            }
        } else {
            0.0
        };

        let camera_only_zoom = if matches!(next_mode, LayoutMode::CameraOnly)
            && !matches!(current_mode, LayoutMode::CameraOnly)
        {
            Self::lerp(1.1, 1.0, transition_progress)
        } else if matches!(current_mode, LayoutMode::CameraOnly)
            && !matches!(next_mode, LayoutMode::CameraOnly)
        {
            Self::lerp(1.0, 1.1, transition_progress)
        } else {
            1.0
        };

        let camera_only_blur = if matches!(next_mode, LayoutMode::CameraOnly)
            && !matches!(current_mode, LayoutMode::CameraOnly)
        {
            Self::lerp(1.0, 0.0, transition_progress)
        } else if matches!(current_mode, LayoutMode::CameraOnly)
            && !matches!(next_mode, LayoutMode::CameraOnly)
        {
            transition_progress
        } else {
            0.0
        };

        InterpolatedLayout {
            camera_opacity,
            screen_opacity,
            camera_scale,
            layout_mode: if transition_progress > 0.5 {
                next_mode.clone()
            } else {
                current_mode.clone()
            },
            transition_progress,
            from_mode: current_mode,
            to_mode: next_mode,
            screen_blur,
            camera_only_zoom,
            camera_only_blur,
        }
    }

    fn get_layout_values(mode: &LayoutMode) -> (f64, f64, f64) {
        match mode {
            LayoutMode::Default => (1.0, 1.0, 1.0),
            LayoutMode::CameraOnly => (1.0, 1.0, 1.0),
            LayoutMode::HideCamera => (0.0, 1.0, 1.0),
        }
    }

    fn lerp(start: f64, end: f64, t: f64) -> f64 {
        start + (end - start) * t
    }

    pub fn should_render_camera(&self) -> bool {
        self.camera_opacity > 0.01
    }

    pub fn should_render_screen(&self) -> bool {
        true
    }

    pub fn is_transitioning_camera_only(&self) -> bool {
        matches!(self.from_mode, LayoutMode::CameraOnly)
            || matches!(self.to_mode, LayoutMode::CameraOnly)
    }

    pub fn camera_only_transition_opacity(&self) -> f64 {
        if matches!(self.from_mode, LayoutMode::CameraOnly)
            && !matches!(self.to_mode, LayoutMode::CameraOnly)
        {
            1.0 - self.transition_progress
        } else if !matches!(self.from_mode, LayoutMode::CameraOnly)
            && matches!(self.to_mode, LayoutMode::CameraOnly)
        {
            self.transition_progress
        } else if matches!(self.from_mode, LayoutMode::CameraOnly)
            && matches!(self.to_mode, LayoutMode::CameraOnly)
        {
            1.0
        } else {
            0.0
        }
    }

    pub fn regular_camera_transition_opacity(&self) -> f64 {
        if matches!(self.to_mode, LayoutMode::CameraOnly)
            && !matches!(self.from_mode, LayoutMode::CameraOnly)
        {
            let fast_fade = (1.0 - self.transition_progress * 1.5).max(0.0);
            fast_fade * self.camera_opacity
        } else if matches!(self.from_mode, LayoutMode::CameraOnly)
            && !matches!(self.to_mode, LayoutMode::CameraOnly)
        {
            let fast_fade = (self.transition_progress * 1.5).min(1.0);
            fast_fade * self.camera_opacity
        } else if matches!(self.from_mode, LayoutMode::CameraOnly)
            && matches!(self.to_mode, LayoutMode::CameraOnly)
        {
            0.0
        } else {
            self.camera_opacity
        }
    }
}
