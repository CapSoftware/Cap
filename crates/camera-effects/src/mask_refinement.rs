pub struct MaskRefiner {
    width: usize,
    previous_frame: Vec<u8>,
    frame_difference: Vec<u8>,
    motion_history: Vec<u8>,
    labels: Vec<usize>,
    queue: Vec<usize>,
    regions: Vec<(usize, usize)>,
}

impl MaskRefiner {
    pub fn new(width: usize, height: usize) -> Self {
        Self {
            width,
            previous_frame: vec![0; width * height * 4],
            frame_difference: vec![0; width * height],
            motion_history: vec![0; width * height],
            labels: vec![0; width * height],
            queue: Vec::with_capacity(width * height),
            regions: Vec::with_capacity(128),
        }
    }

    pub fn refine(
        &mut self,
        mask: &mut [f32],
        previous: &[f32],
        frame: &mut Vec<u8>,
        initialized: bool,
    ) {
        self.remove_weak_regions(mask);
        if initialized {
            for (index, difference) in self.frame_difference.iter_mut().enumerate() {
                let offset = index * 4;
                *difference = (0..3)
                    .map(|channel| {
                        frame[offset + channel].abs_diff(self.previous_frame[offset + channel])
                    })
                    .max()
                    .unwrap_or(0);
            }
            let height = mask.len() / self.width;
            for (index, value) in mask.iter_mut().enumerate() {
                let x = index % self.width;
                let y = index / self.width;
                let mut motion = (u16::from(self.motion_history[index]) * 3 / 4) as u8;
                for row in y.saturating_sub(1)..=(y + 1).min(height - 1) {
                    for col in x.saturating_sub(1)..=(x + 1).min(self.width - 1) {
                        motion = motion.max(self.frame_difference[row * self.width + col]);
                    }
                }
                self.motion_history[index] = motion;
                *value = smooth_mask_value(previous[index], *value, f32::from(motion) / 255.0);
            }
        } else {
            self.motion_history.fill(0);
        }
        std::mem::swap(&mut self.previous_frame, frame);
    }

    fn remove_weak_regions(&mut self, mask: &mut [f32]) {
        self.labels.fill(0);
        self.regions.clear();
        self.regions.push((0, 0));
        let threshold = (mask.iter().copied().fold(0.0_f32, f32::max) * 0.5).clamp(0.1, 0.5);
        for (start, &value) in mask.iter().enumerate() {
            if value < threshold || self.labels[start] != 0 {
                continue;
            }
            let label = self.regions.len();
            self.labels[start] = label;
            self.queue.clear();
            self.queue.push(start);
            let mut cursor = 0;
            let mut confident = 0;
            while cursor < self.queue.len() {
                let index = self.queue[cursor];
                cursor += 1;
                confident += usize::from(mask[index] >= 0.9);
                let x = index % self.width;
                let neighbors = [
                    (x > 0).then(|| index - 1),
                    (x + 1 < self.width).then_some(index + 1),
                    index.checked_sub(self.width),
                    (index + self.width < mask.len()).then_some(index + self.width),
                ];
                for neighbor in neighbors.into_iter().flatten() {
                    if self.labels[neighbor] == 0 && mask[neighbor] >= threshold {
                        self.labels[neighbor] = label;
                        self.queue.push(neighbor);
                    }
                }
            }
            self.regions.push((self.queue.len(), confident));
        }
        let largest = self
            .regions
            .iter()
            .enumerate()
            .max_by_key(|(_, region)| region.0)
            .map_or(0, |(label, _)| label);
        if largest == 0 {
            mask.fill(0.0);
            return;
        }
        for (index, value) in mask.iter_mut().enumerate() {
            let label = self.labels[index];
            let x = index % self.width;
            let y = index / self.width;
            let near_subject = label == 0
                && *value > 0.0
                && (y.saturating_sub(2)..=(y + 2).min(self.labels.len() / self.width - 1)).any(
                    |row| {
                        (x.saturating_sub(2)..=(x + 2).min(self.width - 1)).any(|col| {
                            let label = self.labels[row * self.width + col];
                            label == largest || self.regions[label].1 >= 8
                        })
                    },
                );
            if label != largest && self.regions[label].1 < 8 && !near_subject {
                *value = 0.0;
            }
        }
    }
}

pub fn smooth_mask_value(previous: f32, next: f32, image_motion: f32) -> f32 {
    let motion = ((image_motion - 0.01) / 0.06).clamp(0.0, 1.0);
    let alpha = 0.18 + motion * 0.72;
    (previous + (next - previous) * alpha).clamp(0.0, 1.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stationary_image_noise_is_smoothed_without_delaying_motion() {
        assert!((smooth_mask_value(0.8, 0.2, 0.0) - 0.692).abs() < 0.001);
        assert!(smooth_mask_value(0.0, 1.0, 0.3) >= 0.89);
        assert!(smooth_mask_value(1.0, 0.0, 0.3) <= 0.11);
    }

    #[test]
    fn weak_background_islands_are_removed_without_removing_detached_hands() {
        let mut refiner = MaskRefiner::new(32, 32);
        let mut mask = vec![0.0; 1024];
        for y in 8..30 {
            for x in 5..15 {
                mask[y * 32 + x] = 1.0;
            }
        }
        for y in 20..24 {
            for x in 24..28 {
                mask[y * 32 + x] = 0.7;
            }
        }
        for y in 2..5 {
            for x in 20..24 {
                mask[y * 32 + x] = 1.0;
            }
        }
        refiner.remove_weak_regions(&mut mask);
        assert_eq!(mask[22 * 32 + 25], 0.0);
        assert_eq!(mask[3 * 32 + 21], 1.0);
        assert_eq!(mask[20 * 32 + 10], 1.0);
    }

    #[test]
    fn a_small_or_low_confidence_primary_subject_is_preserved() {
        let mut refiner = MaskRefiner::new(8, 8);
        let mut mask = vec![0.0; 64];
        mask[18] = 0.3;
        mask[19] = 0.2;
        refiner.remove_weak_regions(&mut mask);
        assert_eq!(mask[18], 0.3);
        assert_eq!(mask[19], 0.2);
    }

    #[test]
    fn recent_motion_stays_responsive_when_the_image_stops_moving() {
        let mut refiner = MaskRefiner::new(4, 4);
        let mut frame = vec![255; 64];
        let frame_pointer = frame.as_ptr();
        let previous_pointer = refiner.previous_frame.as_ptr();
        let mut mask = vec![1.0; 16];
        refiner.refine(&mut mask, &[0.0; 16], &mut frame, true);
        assert!(mask.iter().all(|value| *value >= 0.89));
        assert_eq!(refiner.previous_frame.as_ptr(), frame_pointer);
        assert_eq!(frame.as_ptr(), previous_pointer);
        let previous = mask.clone();
        mask.fill(0.0);
        frame.fill(255);
        refiner.refine(&mut mask, &previous, &mut frame, true);
        assert!(mask.iter().all(|value| *value < 0.1));
        assert_eq!(refiner.previous_frame.as_ptr(), previous_pointer);
        assert_eq!(frame.as_ptr(), frame_pointer);
    }
}
