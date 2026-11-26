use crate::image::Rect;

/// Text line boxes from a DB probability map: connected regions above
/// `prob_threshold`, kept when their mean probability reaches
/// `box_threshold`, grown by the DB unclip offset (area * unclip /
/// perimeter). Only the top-left `width` x `height` of the map (row stride
/// `stride`) is read; boxes are in map pixels.
#[allow(clippy::too_many_arguments)]
pub fn boxes_from_probability(
    probs: &[f32],
    stride: usize,
    rows: usize,
    width: usize,
    height: usize,
    prob_threshold: f32,
    box_threshold: f32,
    unclip: f32,
) -> Vec<(Rect, f32)> {
    let width = width.min(stride);
    let height = height.min(rows);
    let mut labels = vec![0u32; width * height];
    let mut boxes = Vec::new();
    let mut stack = Vec::new();
    let mut next_label = 1u32;
    for start_y in 0..height {
        for start_x in 0..width {
            let start = start_y * width + start_x;
            if labels[start] != 0 || probs[start_y * stride + start_x] <= prob_threshold {
                continue;
            }
            let label = next_label;
            next_label += 1;
            labels[start] = label;
            stack.push((start_x, start_y));
            let (mut x0, mut y0, mut x1, mut y1) = (start_x, start_y, start_x, start_y);
            let mut sum = 0.0f32;
            let mut count = 0usize;
            while let Some((x, y)) = stack.pop() {
                sum += probs[y * stride + x];
                count += 1;
                x0 = x0.min(x);
                x1 = x1.max(x);
                y0 = y0.min(y);
                y1 = y1.max(y);
                let neighbours = [
                    (x.wrapping_sub(1), y),
                    (x + 1, y),
                    (x, y.wrapping_sub(1)),
                    (x, y + 1),
                ];
                for (nx, ny) in neighbours {
                    if nx >= width || ny >= height {
                        continue;
                    }
                    let index = ny * width + nx;
                    if labels[index] == 0 && probs[ny * stride + nx] > prob_threshold {
                        labels[index] = label;
                        stack.push((nx, ny));
                    }
                }
            }
            let w = (x1 - x0 + 1) as f32;
            let h = (y1 - y0 + 1) as f32;
            if w < 3.0 || h < 3.0 || count < 6 {
                continue;
            }
            let score = sum / count as f32;
            if score < box_threshold {
                continue;
            }
            let area = w * h;
            let perimeter = 2.0 * (w + h);
            let offset = area * unclip / perimeter;
            boxes.push((
                Rect::new(
                    x0 as f32 - offset,
                    y0 as f32 - offset,
                    w + 2.0 * offset,
                    h + 2.0 * offset,
                ),
                score,
            ));
        }
    }
    boxes
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn separate_lines_become_separate_boxes() {
        let (w, h) = (40, 20);
        let mut probs = vec![0.0f32; w * h];
        for y in 3..6 {
            for x in 2..30 {
                probs[y * w + x] = 0.9;
            }
        }
        for y in 12..15 {
            for x in 5..20 {
                probs[y * w + x] = 0.8;
            }
        }
        probs[18 * w + 38] = 0.95;
        let boxes = boxes_from_probability(&probs, w, h, w, h, 0.3, 0.5, 1.5);
        assert_eq!(boxes.len(), 2);
        let first = boxes[0].0;
        assert!(first.x < 2.0 && first.right() > 30.0);
        assert!(first.y < 3.0 && first.bottom() > 6.0);
    }
}
