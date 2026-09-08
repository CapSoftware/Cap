use cap_project::{TextAlign, TextAnimation, TextSegment, XY};

/// Text font sizes are authored against a 1080p-tall reference frame and
/// scaled to the output height, so a project renders identically at every
/// export resolution. `size` only positions and wraps the text — it never
/// affects glyph size (that coupling is baked away by the config migration
/// in cap_project).
const REFERENCE_HEIGHT: f32 = 1080.0;
pub const MIN_FONT_SIZE: f32 = 8.0;
pub const MAX_FONT_SIZE: f32 = 480.0;

#[derive(Debug, Clone)]
pub struct PreparedText {
    pub content: String,
    pub bounds: [f32; 4],
    pub color: [f32; 4],
    pub background_color: Option<[f32; 4]>,
    pub font_family: String,
    pub font_size: f32,
    pub font_weight: f32,
    pub italic: bool,
    pub opacity: f32,
    pub align: TextAlign,
    /// Output px, already scaled from the 1080p reference.
    pub letter_spacing: f32,
    /// Multiplier of `font_size`.
    pub line_height: f32,
    /// 0..1 drop-shadow strength; 0 disables the shadow pass.
    pub shadow: f32,
    /// Animation translation in output px, applied to the whole block.
    pub offset: [f32; 2],
    /// Animation scale about the box center.
    pub scale: f32,
}

fn parse_color(hex: &str) -> [f32; 4] {
    parse_rgb_color(hex).unwrap_or([1.0, 1.0, 1.0, 1.0])
}

fn parse_rgb_color(hex: &str) -> Option<[f32; 4]> {
    let color = hex.trim_start_matches('#');
    if color.len() == 6
        && color.is_ascii()
        && let (Ok(r), Ok(g), Ok(b)) = (
            u8::from_str_radix(&color[0..2], 16),
            u8::from_str_radix(&color[2..4], 16),
            u8::from_str_radix(&color[4..6], 16),
        )
    {
        return Some([r as f32 / 255.0, g as f32 / 255.0, b as f32 / 255.0, 1.0]);
    }

    None
}

pub(crate) fn text_background_rect(
    bounds: [f32; 4],
    laid_out_height: f32,
    font_size: f32,
    scale: f32,
    offset: [f32; 2],
) -> ([f32; 4], f32) {
    let padding = font_size * 0.2;
    let left = bounds[0] - padding;
    let top = bounds[1] - padding;
    let right = bounds[2] + padding;
    let bottom = bounds[1] + (bounds[3] - bounds[1]).max(laid_out_height) + padding;
    let cx = (bounds[0] + bounds[2]) * 0.5;
    let cy = (bounds[1] + bounds[3]) * 0.5;
    let transform = |x: f32, y: f32| {
        [
            cx + (x - cx) * scale + offset[0],
            cy + (y - cy) * scale + offset[1],
        ]
    };
    let [transformed_left, transformed_top] = transform(left, top);
    let [transformed_right, transformed_bottom] = transform(right, bottom);
    let width = (transformed_right - transformed_left).max(0.0);
    let height = (transformed_bottom - transformed_top).max(0.0);
    (
        [transformed_left, transformed_top, width, height],
        (font_size * 0.15 * scale)
            .min(width * 0.5)
            .min(height * 0.5),
    )
}

fn ease_out_cubic(t: f32) -> f32 {
    let t = t.clamp(0.0, 1.0);
    1.0 - (1.0 - t).powi(3)
}

fn ease_out_back(t: f32) -> f32 {
    let t = t.clamp(0.0, 1.0);
    let c1 = 1.70158;
    let c3 = c1 + 1.0;
    let p = t - 1.0;
    1.0 + c3 * p * p * p + c1 * p * p
}

const POP_MIN_SCALE: f32 = 0.8;

#[derive(Debug, Clone, Copy)]
struct AnimSample {
    alpha: f32,
    offset: [f32; 2],
    scale: f32,
    /// Fraction of characters visible (typewriter); 1 for other styles.
    reveal: f32,
}

const ANIM_REST: AnimSample = AnimSample {
    alpha: 1.0,
    offset: [0.0, 0.0],
    scale: 1.0,
    reveal: 1.0,
};

/// `progress` runs 0 → 1 toward fully visible for both edges: time since
/// start over the enter duration, time until end over the exit duration.
/// `direction` is +1 entering and -1 exiting so slides continue through the
/// text's resting position (enter from below, exit above) instead of
/// retracing themselves.
fn sample_animation(
    style: TextAnimation,
    progress: f32,
    direction: f32,
    slide_px: f32,
) -> AnimSample {
    if progress >= 1.0 {
        return ANIM_REST;
    }
    let eased = ease_out_cubic(progress);

    match style {
        TextAnimation::None => ANIM_REST,
        TextAnimation::Fade => AnimSample {
            alpha: eased,
            ..ANIM_REST
        },
        TextAnimation::SlideUp => AnimSample {
            alpha: eased,
            offset: [0.0, direction * (1.0 - eased) * slide_px],
            ..ANIM_REST
        },
        TextAnimation::SlideDown => AnimSample {
            alpha: eased,
            offset: [0.0, -direction * (1.0 - eased) * slide_px],
            ..ANIM_REST
        },
        TextAnimation::Pop => AnimSample {
            alpha: eased,
            scale: POP_MIN_SCALE + (1.0 - POP_MIN_SCALE) * ease_out_back(progress),
            ..ANIM_REST
        },
        TextAnimation::Typewriter => AnimSample {
            reveal: progress,
            ..ANIM_REST
        },
    }
}

fn edge_progress(elapsed: f64, duration: f64) -> f32 {
    if duration <= 0.0 {
        1.0
    } else {
        (elapsed / duration).clamp(0.0, 1.0) as f32
    }
}

/// Truncates to the first `ceil(reveal * chars)` characters on a char
/// boundary, so the typewriter reveal never splits a code point.
fn reveal_content(content: &str, reveal: f32) -> String {
    if reveal >= 1.0 {
        return content.to_string();
    }
    let total = content.chars().count();
    let visible = ((total as f32) * reveal.max(0.0)).ceil() as usize;
    content.chars().take(visible).collect()
}

pub fn prepare_texts(
    output_size: XY<u32>,
    frame_time: f64,
    segments: &[TextSegment],
    hidden_indices: &[usize],
) -> Vec<PreparedText> {
    let mut prepared = Vec::new();
    let height_scale = if output_size.y == 0 {
        1.0
    } else {
        output_size.y as f32 / REFERENCE_HEIGHT
    };

    for (i, segment) in segments.iter().enumerate() {
        if !segment.enabled || hidden_indices.contains(&i) {
            continue;
        }

        if frame_time < segment.start || frame_time > segment.end {
            continue;
        }

        let center = XY::new(
            segment.center.x.clamp(0.0, 1.0),
            segment.center.y.clamp(0.0, 1.0),
        );
        let size = XY::new(
            segment.size.x.clamp(0.01, 2.0),
            segment.size.y.clamp(0.01, 2.0),
        );

        let width = (size.x * output_size.x as f64).max(1.0) as f32;
        let height = (size.y * output_size.y as f64).max(1.0) as f32;

        // The box may overhang frame edges (the editor allows dragging up to
        // half the box outside); glyphon culls anything past the viewport.
        let left = center.x as f32 * output_size.x as f32 - width / 2.0;
        let top = center.y as f32 * output_size.y as f32 - height / 2.0;
        let right = left + width;
        let bottom = top + height;

        let font_size = segment.font_size.clamp(MIN_FONT_SIZE, MAX_FONT_SIZE) * height_scale;
        let slide_px = font_size * 0.5;

        let enter = sample_animation(
            segment.animation_in,
            edge_progress(frame_time - segment.start, segment.animation_in_duration),
            1.0,
            slide_px,
        );
        let exit = sample_animation(
            segment.animation_out,
            edge_progress(segment.end - frame_time, segment.animation_out_duration),
            -1.0,
            slide_px,
        );

        let opacity = segment.opacity.clamp(0.0, 1.0) * enter.alpha * exit.alpha;
        if opacity <= 0.0 {
            continue;
        }

        let reveal = enter.reveal.min(exit.reveal);
        let content = reveal_content(&segment.content, reveal);
        if content.is_empty() {
            continue;
        }

        prepared.push(PreparedText {
            content,
            bounds: [left, top, right, bottom],
            color: parse_color(&segment.color),
            background_color: segment
                .background_color
                .as_deref()
                .and_then(parse_rgb_color),
            font_family: segment.font_family.clone(),
            font_size,
            font_weight: segment.font_weight,
            italic: segment.italic,
            opacity,
            align: segment.align,
            letter_spacing: segment.letter_spacing.clamp(-24.0, 240.0) * height_scale,
            line_height: segment.line_height.clamp(0.5, 3.0),
            shadow: segment.shadow.clamp(0.0, 1.0),
            offset: [
                enter.offset[0] + exit.offset[0],
                enter.offset[1] + exit.offset[1],
            ],
            scale: (enter.scale * exit.scale).max(0.01),
        });
    }

    prepared
}

#[cfg(test)]
mod tests {
    use super::*;
    use cap_project::{TextAnimation, TextLayout};

    fn segment(animation_in: TextAnimation, animation_out: TextAnimation) -> TextSegment {
        TextSegment {
            start: 0.0,
            end: 10.0,
            track: 0,
            enabled: true,
            content: "Hello".to_string(),
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
            animation_in,
            animation_out,
            animation_in_duration: 1.0,
            animation_out_duration: 1.0,
            layout: TextLayout::Overlay,
            layout_transition: 0.5,
        }
    }

    fn prepare_one(seg: TextSegment, time: f64) -> Option<PreparedText> {
        prepare_texts(XY::new(1920, 1080), time, &[seg], &[])
            .into_iter()
            .next()
    }

    #[test]
    fn resting_text_has_identity_animation_state() {
        let text = prepare_one(segment(TextAnimation::Fade, TextAnimation::Fade), 5.0).unwrap();
        assert_eq!(text.opacity, 1.0);
        assert_eq!(text.offset, [0.0, 0.0]);
        assert_eq!(text.scale, 1.0);
        assert_eq!(text.content, "Hello");
        assert_eq!(text.background_color, None);
    }

    #[test]
    fn background_color_is_prepared_and_invalid_colors_are_ignored() {
        let mut with_background = segment(TextAnimation::None, TextAnimation::None);
        with_background.background_color = Some("#102030".to_string());
        let prepared = prepare_one(with_background, 5.0).unwrap();
        assert_eq!(
            prepared.background_color,
            Some([16.0 / 255.0, 32.0 / 255.0, 48.0 / 255.0, 1.0])
        );

        let mut malformed = segment(TextAnimation::None, TextAnimation::None);
        malformed.color = "#ééé".to_string();
        malformed.background_color = Some("#ééé".to_string());
        let prepared = prepare_one(malformed, 5.0).unwrap();
        assert_eq!(prepared.color, [1.0, 1.0, 1.0, 1.0]);
        assert_eq!(prepared.background_color, None);
    }

    #[test]
    fn background_rect_expands_authored_bounds_then_transforms_about_center() {
        let (rect, radius) = text_background_rect(
            [100.0, 200.0, 300.0, 400.0],
            100.0,
            50.0,
            0.5,
            [10.0, -20.0],
        );
        assert_eq!(rect, [155.0, 225.0, 110.0, 110.0]);
        assert!((radius - 3.75).abs() < 0.000_001);
    }

    #[test]
    fn multiline_background_keeps_the_authored_transform_origin() {
        let (rect, _) = text_background_rect(
            [100.0, 200.0, 300.0, 400.0],
            300.0,
            50.0,
            0.5,
            [10.0, -20.0],
        );
        assert_eq!(rect, [155.0, 225.0, 110.0, 160.0]);
    }

    #[test]
    fn fade_ramps_in_and_out() {
        let early = prepare_one(segment(TextAnimation::Fade, TextAnimation::Fade), 0.25).unwrap();
        assert!(early.opacity > 0.0 && early.opacity < 1.0);

        let late = prepare_one(segment(TextAnimation::Fade, TextAnimation::Fade), 9.75).unwrap();
        assert!(late.opacity > 0.0 && late.opacity < 1.0);
    }

    #[test]
    fn slide_up_enters_from_below_and_exits_above() {
        let entering = prepare_one(
            segment(TextAnimation::SlideUp, TextAnimation::SlideUp),
            0.25,
        )
        .unwrap();
        assert!(entering.offset[1] > 0.0);

        let exiting = prepare_one(
            segment(TextAnimation::SlideUp, TextAnimation::SlideUp),
            9.75,
        )
        .unwrap();
        assert!(exiting.offset[1] < 0.0);
    }

    #[test]
    fn pop_scales_up_from_min() {
        let entering = prepare_one(segment(TextAnimation::Pop, TextAnimation::None), 0.05).unwrap();
        assert!(entering.scale < 1.0);
        assert!(entering.scale >= POP_MIN_SCALE);
    }

    #[test]
    fn typewriter_reveals_characters_over_time() {
        let seg = segment(TextAnimation::Typewriter, TextAnimation::None);
        let mid = prepare_one(seg.clone(), 0.5).unwrap();
        assert!(mid.content.len() < "Hello".len());
        assert!(mid.content.starts_with(&seg.content[..1]));
        assert_eq!(mid.opacity, 1.0);

        let done = prepare_one(seg, 2.0).unwrap();
        assert_eq!(done.content, "Hello");
    }

    #[test]
    fn typewriter_start_renders_nothing() {
        assert!(
            prepare_one(segment(TextAnimation::Typewriter, TextAnimation::None), 0.0).is_none()
        );
    }

    #[test]
    fn none_animation_shows_instantly() {
        let text = prepare_one(segment(TextAnimation::None, TextAnimation::None), 0.0).unwrap();
        assert_eq!(text.opacity, 1.0);
        assert_eq!(text.scale, 1.0);
    }

    #[test]
    fn segment_opacity_multiplies_animation_alpha() {
        let mut seg = segment(TextAnimation::None, TextAnimation::None);
        seg.opacity = 0.5;
        let text = prepare_one(seg, 5.0).unwrap();
        assert_eq!(text.opacity, 0.5);
    }
}
