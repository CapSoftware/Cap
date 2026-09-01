use cap_project::{TextLayout, TextSegment};

/// At full takeover a Fullscreen text leaves the display card at this scale
/// (about its center) as it fades, so the hand-off reads as a push-back
/// rather than a bare crossfade.
pub const TAKEOVER_FULLSCREEN_SHRINK: f32 = 0.92;
const MIN_TRANSITION: f64 = 0.05;

/// Per-frame state of the text-takeover morph: how far (`t`, eased 0..1) the
/// display has yielded the frame to a non-Overlay text segment, and which
/// layout it is yielding to. `None` when every active text segment is a plain
/// overlay — the pipeline then computes exactly what it did before this
/// feature existed.
#[derive(Clone, Copy, Debug)]
pub struct InterpolatedTakeover {
    pub t: f32,
    pub layout: TextLayout,
}

/// Cursor-side view of the display morph: the display card's pre-takeover
/// rect, its rect at full takeover, and the morph amount. The takeover
/// target preserves the card's aspect, so the cursor remap is a uniform
/// scale + translate.
#[derive(Clone, Copy, Debug)]
pub struct TakeoverDisplayMorph {
    pub t: f32,
    pub from: [f32; 4],
    pub to: [f32; 4],
    /// Multiplier for the cursor sprite and recording-anchored overlays
    /// (captions, keyboard): fades with the display in Fullscreen, stays 1
    /// for splits where the recording remains visible.
    pub overlay_fade: f32,
}

impl InterpolatedTakeover {
    pub fn sample(frame_time: f64, segments: &[TextSegment]) -> Option<Self> {
        let mut best: Option<(f32, f64, TextLayout)> = None;
        for segment in segments {
            if !segment.enabled || segment.layout == TextLayout::Overlay {
                continue;
            }
            if frame_time < segment.start || frame_time > segment.end {
                continue;
            }
            let half = ((segment.end - segment.start) / 2.0).max(MIN_TRANSITION);
            let duration = segment.layout_transition.clamp(MIN_TRANSITION, half);
            let progress = ((frame_time - segment.start) / duration)
                .min((segment.end - frame_time) / duration)
                .clamp(0.0, 1.0) as f32;
            if progress <= 0.0 {
                continue;
            }
            let replace = match best {
                None => true,
                Some((t, start, _)) => progress > t || (progress == t && segment.start > start),
            };
            if replace {
                best = Some((progress, segment.start, segment.layout));
            }
        }
        best.map(|(progress, _, layout)| {
            // Same cubic-bezier(0.42, 0, 0.58, 1) the scene transitions use,
            // so display morphs feel identical across features.
            let ease_in_out = bezier_easing::bezier_easing(0.42, 0.0, 0.58, 1.0).unwrap();
            Self {
                t: ease_in_out(progress),
                layout,
            }
        })
    }

    /// The display card's rect at FULL takeover (`t == 1`); callers lerp from
    /// the pre-takeover rect toward it by `t`. Splits contain-fit the card's
    /// current aspect into the padded opposite half, so the crop — and with
    /// it the visible content — never distorts mid-morph.
    pub fn display_target(
        &self,
        base: [f32; 4],
        output_size: (f32, f32),
        padding: f32,
    ) -> [f32; 4] {
        match self.layout {
            TextLayout::Overlay => base,
            TextLayout::Fullscreen => shrink_about_center(base, TAKEOVER_FULLSCREEN_SHRINK),
            TextLayout::SplitLeft | TextLayout::SplitRight => {
                let (out_w, out_h) = output_size;
                let mid = out_w * 0.5;
                let half_box = if self.layout == TextLayout::SplitLeft {
                    [mid + padding, padding, out_w - padding, out_h - padding]
                } else {
                    [padding, padding, mid - padding, out_h - padding]
                };
                contain_aspect(base, half_box)
            }
        }
    }

    /// Multiplier for the display card's own opacity, and for the decoration
    /// (shadow/border) the shader draws OUTSIDE the card shape — the fragment
    /// returns those unscaled by the opacity uniform, so they must fade here
    /// or a ghost shadow outlives a Fullscreen takeover.
    pub fn display_fade(&self) -> f32 {
        match self.layout {
            TextLayout::Fullscreen => 1.0 - self.t,
            _ => 1.0,
        }
    }

    /// Multiplier for layers whose geometry stops describing the morphed
    /// card (notch, frame chrome) or that would collide with the text
    /// (camera bubble, camera-only plane).
    pub fn accessory_fade(&self) -> f32 {
        1.0 - self.t
    }

    /// 0..1 amount of floating-card styling (rounding) the display picks up;
    /// only splits become cards — a Fullscreen card keeps its look while it
    /// fades.
    pub fn card_style_t(&self) -> f32 {
        match self.layout {
            TextLayout::SplitLeft | TextLayout::SplitRight => self.t,
            _ => 0.0,
        }
    }
}

fn shrink_about_center(bounds: [f32; 4], scale: f32) -> [f32; 4] {
    let cx = (bounds[0] + bounds[2]) * 0.5;
    let cy = (bounds[1] + bounds[3]) * 0.5;
    let hw = (bounds[2] - bounds[0]) * 0.5 * scale;
    let hh = (bounds[3] - bounds[1]) * 0.5 * scale;
    [cx - hw, cy - hh, cx + hw, cy + hh]
}

fn contain_aspect(base: [f32; 4], container: [f32; 4]) -> [f32; 4] {
    let base_w = (base[2] - base[0]).max(f32::EPSILON);
    let base_h = (base[3] - base[1]).max(f32::EPSILON);
    let aspect = base_w / base_h;
    let box_w = (container[2] - container[0]).max(f32::EPSILON);
    let box_h = (container[3] - container[1]).max(f32::EPSILON);
    let (w, h) = if box_w / box_h > aspect {
        (box_h * aspect, box_h)
    } else {
        (box_w, box_w / aspect)
    };
    let cx = (container[0] + container[2]) * 0.5;
    let cy = (container[1] + container[3]) * 0.5;
    [cx - w * 0.5, cy - h * 0.5, cx + w * 0.5, cy + h * 0.5]
}

#[cfg(test)]
mod tests {
    use super::*;
    use cap_project::{TextAlign, TextAnimation, XY};

    fn segment(layout: TextLayout, start: f64, end: f64) -> TextSegment {
        TextSegment {
            start,
            end,
            track: 0,
            enabled: true,
            content: "Text".to_string(),
            center: XY::new(0.5, 0.5),
            size: XY::new(0.35, 0.2),
            font_family: "sans-serif".to_string(),
            font_size: 48.0,
            font_weight: 700.0,
            italic: false,
            color: "#ffffff".to_string(),
            background_color: None,
            fade_duration: 0.15,
            align: TextAlign::Center,
            letter_spacing: 0.0,
            line_height: 1.2,
            opacity: 1.0,
            shadow: 0.0,
            animation_in: TextAnimation::Fade,
            animation_out: TextAnimation::Fade,
            animation_in_duration: 0.15,
            animation_out_duration: 0.15,
            layout,
            layout_transition: 0.5,
        }
    }

    #[test]
    fn overlay_segments_never_produce_a_takeover() {
        let segments = [segment(TextLayout::Overlay, 0.0, 10.0)];
        assert!(InterpolatedTakeover::sample(5.0, &segments).is_none());
    }

    #[test]
    fn takeover_is_none_outside_the_segment() {
        let segments = [segment(TextLayout::Fullscreen, 2.0, 4.0)];
        assert!(InterpolatedTakeover::sample(1.0, &segments).is_none());
        assert!(InterpolatedTakeover::sample(5.0, &segments).is_none());
        assert!(InterpolatedTakeover::sample(2.0, &segments).is_none());
    }

    #[test]
    fn takeover_ramps_in_and_out() {
        let segments = [segment(TextLayout::Fullscreen, 0.0, 10.0)];
        let entering = InterpolatedTakeover::sample(0.25, &segments).unwrap();
        assert!(entering.t > 0.0 && entering.t < 1.0);
        let held = InterpolatedTakeover::sample(5.0, &segments).unwrap();
        assert_eq!(held.t, 1.0);
        let exiting = InterpolatedTakeover::sample(9.75, &segments).unwrap();
        assert!(exiting.t > 0.0 && exiting.t < 1.0);
    }

    #[test]
    fn disabled_segments_are_ignored() {
        let mut seg = segment(TextLayout::Fullscreen, 0.0, 10.0);
        seg.enabled = false;
        assert!(InterpolatedTakeover::sample(5.0, &[seg]).is_none());
    }

    #[test]
    fn dominant_segment_wins() {
        let fading = segment(TextLayout::Fullscreen, 0.0, 5.1);
        let entering = segment(TextLayout::SplitLeft, 5.0, 10.0);
        let sampled = InterpolatedTakeover::sample(5.05, &[fading, entering]).unwrap();
        // Both are near-zero activity at the crossover; the later start wins
        // ties, and by 5.4 the entering split clearly dominates.
        let later = InterpolatedTakeover::sample(
            5.4,
            &[
                segment(TextLayout::Fullscreen, 0.0, 5.1),
                segment(TextLayout::SplitLeft, 5.0, 10.0),
            ],
        )
        .unwrap();
        assert_eq!(later.layout, TextLayout::SplitLeft);
        assert!(sampled.t <= later.t);
    }

    #[test]
    fn split_target_preserves_aspect_in_opposite_half() {
        let takeover = InterpolatedTakeover {
            t: 1.0,
            layout: TextLayout::SplitLeft,
        };
        let base = [100.0, 100.0, 1820.0, 980.0];
        let target = takeover.display_target(base, (1920.0, 1080.0), 54.0);
        let base_aspect = (base[2] - base[0]) / (base[3] - base[1]);
        let target_aspect = (target[2] - target[0]) / (target[3] - target[1]);
        assert!((base_aspect - target_aspect).abs() < 1e-3);
        // Text-left means the card lives entirely in the right half.
        assert!(target[0] >= 960.0);
        assert!(target[2] <= 1920.0);
    }

    #[test]
    fn fullscreen_target_shrinks_about_center() {
        let takeover = InterpolatedTakeover {
            t: 1.0,
            layout: TextLayout::Fullscreen,
        };
        let base = [0.0, 0.0, 1920.0, 1080.0];
        let target = takeover.display_target(base, (1920.0, 1080.0), 54.0);
        assert!((target[0] + target[2] - 1920.0).abs() < 1e-3);
        assert!((target[1] + target[3] - 1080.0).abs() < 1e-3);
        assert!((target[2] - target[0]) < 1920.0);
        assert_eq!(takeover.display_fade(), 0.0);
    }

    #[test]
    fn split_keeps_display_visible() {
        let takeover = InterpolatedTakeover {
            t: 1.0,
            layout: TextLayout::SplitRight,
        };
        assert_eq!(takeover.display_fade(), 1.0);
        assert_eq!(takeover.accessory_fade(), 0.0);
        assert_eq!(takeover.card_style_t(), 1.0);
    }

    #[test]
    fn transition_clamps_to_half_segment_length() {
        let mut seg = segment(TextLayout::Fullscreen, 0.0, 0.4);
        seg.layout_transition = 5.0;
        // With the transition clamped to 0.2s, the midpoint reaches full
        // takeover instead of being stuck near zero.
        let mid = InterpolatedTakeover::sample(0.2, &[seg]).unwrap();
        assert_eq!(mid.t, 1.0);
    }
}
