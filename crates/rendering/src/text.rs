use cap_project::{TextSegment, XY};

const BASE_TEXT_HEIGHT: f64 = 0.2;

#[derive(Debug, Clone)]
pub struct PreparedText {
    pub content: String,
    pub bounds: [f32; 4],
    pub color: [f32; 4],
    pub font_family: String,
    pub font_size: f32,
    pub font_weight: f32,
    pub italic: bool,
}

fn parse_color(hex: &str) -> [f32; 4] {
    let color = hex.trim_start_matches('#');
    if color.len() == 6 {
        if let (Ok(r), Ok(g), Ok(b)) = (
            u8::from_str_radix(&color[0..2], 16),
            u8::from_str_radix(&color[2..4], 16),
            u8::from_str_radix(&color[4..6], 16),
        ) {
            return [r as f32 / 255.0, g as f32 / 255.0, b as f32 / 255.0, 1.0];
        }
    }

    [1.0, 1.0, 1.0, 1.0]
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
        output_size.y as f32 / 1080.0
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
        let size_scale = (size.y / BASE_TEXT_HEIGHT).clamp(0.25, 4.0) as f32;

        let width = (size.x * output_size.x as f64).max(1.0) as f32;
        let height = (size.y * output_size.y as f64).max(1.0) as f32;
        let half_w = width / 2.0;
        let half_h = height / 2.0;

        let left = (center.x as f32 * output_size.x as f32 - half_w).max(0.0);
        let top = (center.y as f32 * output_size.y as f32 - half_h).max(0.0);
        let right = (left + width).min(output_size.x as f32);
        let bottom = (top + height).min(output_size.y as f32);

        prepared.push(PreparedText {
            content: segment.content.clone(),
            bounds: [left, top, right, bottom],
            color: parse_color(&segment.color),
            font_family: segment.font_family.clone(),
            font_size: (segment.font_size * size_scale).max(1.0) * height_scale,
            font_weight: segment.font_weight,
            italic: segment.italic,
        });
    }

    prepared
}
